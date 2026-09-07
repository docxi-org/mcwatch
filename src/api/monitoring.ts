import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Db } from '../db/index.js';
import { crawlState } from '../db/schema.js';
import type { Monitor } from '../workers/monitor.js';
import type { Scheduler } from '../workers/scheduler.js';
import { utcDate } from '../db/repo/crawlState.js';
import {
  browseListPageUrl,
  NEW_RELEASES_PAGE_URL,
} from '../clients/metacritic/endpoints.js';
import { letsplayOutcomes } from '../db/repo/letsplays.js';
import { desc } from 'drizzle-orm';

/**
 * Мониторинг работы сервиса — ТЗ, дополнительная часть 2.
 * Маршруты — `docs/ARCHITECTURE.md` §5.
 */

export interface MonitoringDeps {
  db: Db;
  monitor: Monitor;
  /** Без планировщика принудительный запуск невозможен и честно об этом говорит. */
  scheduler?: Scheduler | null;
  now?: () => Date;
}

/** Как часто слать пустой кадр, чтобы прокси не закрыл простаивающий поток. */
const SSE_KEEPALIVE_MS = 20_000;

export function createMonitoringRoutes(deps: MonitoringDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  app.get('/status', (c) => {
    const today = utcDate(now());
    const state =
      deps.db
        .select()
        .from(crawlState)
        .orderBy(desc(crawlState.date))
        .limit(1)
        .get() ?? null;

    return c.json({
      workers: deps.monitor.statuses(),
      crawl: state
        ? {
            date: state.date,
            phase: state.phase,
            nextPage: state.nextPage,
            processedToday: state.date === today ? state.processedSlugs.length : 0,
            // Адрес того, что возьмёт следующий заход: по номеру страницы
            // человек источник не найдёт.
            nextUrl:
              state.phase === 'landing'
                ? NEW_RELEASES_PAGE_URL
                : browseListPageUrl(state.nextPage),
          }
        : null,
      cycleRunning: deps.scheduler?.isRunning ?? false,
      schedulerEnabled: Boolean(deps.scheduler),
      // Счётчик воркера считает только заключения; раскладка объясняет, куда
      // делись остальные рассмотренные игры.
      letsplayOutcomes: letsplayOutcomes(deps.db),
      events: deps.monitor.recentEvents(50),
      serverTime: now().toISOString(),
    });
  });

  /**
   * Поток событий. Первым кадром уходит текущий снимок, чтобы подписчику не
   * приходилось отдельно дёргать `/status` ради начального состояния.
   */
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;

      const push = (event: string, data: unknown): void => {
        queue.push(JSON.stringify({ event, data }));
        wake?.();
      };

      const unsubscribe = deps.monitor.subscribe((m) => {
        if (m.kind === 'event') push('event', m.event);
        else push('status', { workers: m.workers, cycleRunning: deps.scheduler?.isRunning ?? false });
      });
      // Отписка обязательна: без неё каждый отвалившийся клиент оставлял бы
      // подписчика навсегда, и монитор рассылал бы в никуда.
      stream.onAbort(unsubscribe);

      push('status', {
        workers: deps.monitor.statuses(),
        cycleRunning: deps.scheduler?.isRunning ?? false,
      });

      try {
        while (!stream.closed && !stream.aborted) {
          while (queue.length > 0) {
            const payload = queue.shift();
            if (payload !== undefined) await stream.writeSSE({ data: payload });
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            stream.sleep(SSE_KEEPALIVE_MS),
          ]);
          wake = null;
          // Пустой комментарий держит соединение живым через прокси.
          if (queue.length === 0) await stream.writeSSE({ data: '', event: 'ping' });
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  /**
   * Принудительный запуск. Не ждёт окончания: цикл длится минуты, держать
   * запрос открытым незачем. 409, если цикл уже идёт (§5).
   */
  app.post('/crawl/run', (c) => {
    if (!deps.scheduler) {
      return c.json(
        { error: 'scheduler_disabled', message: 'Планировщик выключен в настройках' },
        503,
      );
    }
    if (deps.scheduler.isRunning) {
      return c.json({ error: 'already_running' }, 409);
    }

    void deps.scheduler.runCycle();
    return c.json({ started: true }, 202);
  });

  return app;
}
