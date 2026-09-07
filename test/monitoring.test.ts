import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type DbHandle } from '../src/db/index.js';
import { eventsLog } from '../src/db/schema.js';
import {
  EVENTS_LOG_CAP,
  Monitor,
  type MonitorMessage,
  type WorkerEvent,
} from '../src/workers/monitor.js';
import { Scheduler, type Stage } from '../src/workers/scheduler.js';
import { createApp } from '../src/server/app.js';
import {
  browseListPageUrl,
  NEW_RELEASES_PAGE_URL,
} from '../src/clients/metacritic/endpoints.js';

const log = pino({ level: 'silent' });

let dir: string;
let handle: DbHandle;
let monitor: Monitor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcwatch-mon-'));
  handle = createDb(join(dir, 'test.db'));
  runMigrations(handle);
  monitor = new Monitor(handle.db, () => new Date('2026-09-07T12:00:00Z'));
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Состояние воркеров ─────────────────────────────────────────────────────

describe('состояние воркеров', () => {
  it('переходит из работы в простой и сохраняется в базе', () => {
    monitor.started('crawler');
    expect(monitor.statuses()[0]).toMatchObject({
      worker: 'crawler',
      state: 'running',
      lastRunAt: '2026-09-07T12:00:00.000Z',
    });

    monitor.finished('crawler');

    expect(monitor.statuses()[0]).toMatchObject({ state: 'idle', lastError: null });
  });

  it('ошибка переводит в состояние error и запоминает причину', () => {
    monitor.started('crawler');
    monitor.finished('crawler', 'источник недоступен');

    expect(monitor.statuses()[0]).toMatchObject({
      state: 'error',
      lastError: 'источник недоступен',
    });
  });

  it('показывает, чем воркер занят прямо сейчас, и очищает по завершении', () => {
    monitor.started('crawler');
    monitor.item('crawler', 'Onimusha');
    expect(monitor.statuses()[0]?.currentItem).toBe('Onimusha');

    monitor.finished('crawler');

    expect(monitor.statuses()[0]?.currentItem).toBeNull();
  });

  it('счётчики накапливаются, а не перезаписываются', () => {
    monitor.processed('crawler', 5);
    monitor.processed('crawler', 3);
    monitor.failed('crawler');

    expect(monitor.statuses()[0]).toMatchObject({
      processedTotal: 8,
      failedTotal: 1,
    });
  });

  it('счётчики переживают перезапуск: они в базе, а не в памяти', () => {
    monitor.processed('crawler', 7);

    const again = new Monitor(handle.db);

    expect(again.statuses()[0]?.processedTotal).toBe(7);
  });

  it('«проверено» растёт отдельно от «обработано»', () => {
    // Воркер рассмотрел пять единиц, работа нашлась в одной. Без отдельного
    // счётчика честный простой выглядел бы поломкой.
    monitor.checked('summarizer', 5);
    monitor.processed('summarizer');

    expect(monitor.statuses()[0]).toMatchObject({
      checkedTotal: 5,
      processedTotal: 1,
      failedTotal: 0,
    });
  });

  it('«проверено» без единого результата — это ноль обработанных, а не ноль работы', () => {
    monitor.checked('summarizer', 33);

    expect(monitor.statuses()[0]).toMatchObject({ checkedTotal: 33, processedTotal: 0 });
  });

  it('три счётчика не затирают друг друга', () => {
    monitor.checked('crawler', 4);
    monitor.processed('crawler', 3);
    monitor.failed('crawler');
    monitor.checked('crawler');

    expect(monitor.statuses()[0]).toMatchObject({
      checkedTotal: 5,
      processedTotal: 3,
      failedTotal: 1,
    });
  });

  it('воркеры считаются раздельно', () => {
    monitor.processed('crawler', 2);
    monitor.processed('summarizer', 5);

    expect(monitor.statuses().map((s) => [s.worker, s.processedTotal])).toEqual([
      ['crawler', 2],
      ['summarizer', 5],
    ]);
  });
});

// ── Журнал ─────────────────────────────────────────────────────────────────

describe('журнал событий', () => {
  it('пишет событие и отдаёт свежие первыми', () => {
    monitor.log('crawler', 'info', 'первое');
    monitor.log('crawler', 'warn', 'второе', { slug: 'x' });

    const events = monitor.recentEvents();

    expect(events.map((e) => e.message)).toEqual(['второе', 'первое']);
    expect(events[0]).toMatchObject({ level: 'warn', data: { slug: 'x' } });
  });

  it('обрезается по потолку из §3', () => {
    for (let i = 0; i < EVENTS_LOG_CAP + 120; i++) {
      monitor.log('crawler', 'info', `событие ${i}`);
    }

    const left = handle.db.select().from(eventsLog).all().length;

    expect(left).toBeLessThanOrEqual(EVENTS_LOG_CAP + 100);
    expect(left).toBeGreaterThan(EVENTS_LOG_CAP - 1);
  });

  it('обрезка оставляет именно свежие события', () => {
    for (let i = 0; i < EVENTS_LOG_CAP + 10; i++) {
      monitor.log('crawler', 'info', `событие ${i}`);
    }
    monitor.rotateNow();

    expect(monitor.recentEvents(1)[0]?.message).toBe(`событие ${EVENTS_LOG_CAP + 9}`);
  });
});

// ── Подписка ───────────────────────────────────────────────────────────────

describe('подписка на события', () => {
  /** Собирает подписчика, копящего сообщения обоих видов. */
  function collector() {
    const messages: MonitorMessage[] = [];
    const off = monitor.subscribe((m) => messages.push(m));
    const events = (): WorkerEvent[] =>
      messages.flatMap((m) => (m.kind === 'event' ? [m.event] : []));
    const statuses = () => messages.filter((m) => m.kind === 'status');
    return { messages, events, statuses, off };
  }

  it('подписчик получает событие сразу', () => {
    const c = collector();

    monitor.log('crawler', 'info', 'привет');

    expect(c.events().map((e) => e.message)).toEqual(['привет']);
  });

  it('отписка прекращает доставку', () => {
    const c = collector();

    monitor.log('crawler', 'info', 'до');
    c.off();
    monitor.log('crawler', 'info', 'после');

    expect(c.events().map((e) => e.message)).toEqual(['до']);
    expect(monitor.subscriberCount).toBe(0);
  });

  it('несколько подписчиков получают одно и то же', () => {
    const a = collector();
    const b = collector();

    monitor.log('crawler', 'info', 'всем');

    expect(a.events().map((e) => e.message)).toEqual(['всем']);
    expect(b.events().map((e) => e.message)).toEqual(['всем']);
  });

  it('состояния воркера попадают в поток как события журнала', () => {
    const c = collector();

    monitor.started('crawler');
    monitor.finished('crawler');

    expect(c.events().map((e) => e.message)).toEqual([
      'воркер начал работу',
      'воркер закончил работу',
    ]);
  });

  it('ход работы транслируется снимками, но в журнал не пишется', () => {
    const c = collector();

    monitor.item('crawler', 'Onimusha');
    monitor.processed('crawler');

    // Обход длится минуты: без этого поток молчал бы всё это время.
    expect(c.statuses().length).toBe(2);
    // Но засорять журнал каждым элементом незачем.
    expect(monitor.recentEvents()).toEqual([]);
  });

  it('снимок несёт текущий элемент и счётчики', () => {
    const c = collector();

    monitor.item('crawler', 'Onimusha');
    monitor.processed('crawler', 3);

    const last = c.statuses().at(-1);
    expect(last?.workers[0]).toMatchObject({
      worker: 'crawler',
      currentItem: 'Onimusha',
      processedTotal: 3,
    });
  });
});

// ── Маршруты ───────────────────────────────────────────────────────────────

function makeScheduler(stages: Stage[]): Scheduler {
  return new Scheduler({ stages, intervalMs: 3_600_000, lastRunAt: () => null, log });
}

describe('GET /api/status', () => {
  it('отдаёт воркеров, счётчики и последние события', async () => {
    monitor.started('crawler');
    monitor.processed('crawler', 4);
    const app = createApp({ db: handle.db, monitor, scheduler: null });

    const res = await app.request('/api/status');
    const body = (await res.json()) as {
      workers: { worker: string; processedTotal: number }[];
      events: unknown[];
      cycleRunning: boolean;
      schedulerEnabled: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.workers[0]).toMatchObject({ worker: 'crawler', processedTotal: 4 });
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.cycleRunning).toBe(false);
    expect(body.schedulerEnabled).toBe(false);
  });

  it('без монитора маршрут не подключается', async () => {
    const res = await createApp({ db: handle.db }).request('/api/status');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/crawl/run', () => {
  it('запускает цикл и отвечает сразу, не дожидаясь конца', async () => {
    const calls: string[] = [];
    const { promise, resolve } = Promise.withResolvers<undefined>();
    const scheduler = makeScheduler([
      {
        name: 'slow',
        run: async () => {
          calls.push('slow');
          await promise;
        },
      },
    ]);
    const app = createApp({ db: handle.db, monitor, scheduler });

    const res = await app.request('/api/crawl/run', { method: 'POST' });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true });
    expect(calls).toEqual(['slow']);
    resolve(undefined);
  });

  it('во время работы отвечает 409, а не запускает второй цикл', async () => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    const run = vi.fn(async () => {
      await promise;
    });
    const scheduler = makeScheduler([{ name: 'slow', run }]);
    const app = createApp({ db: handle.db, monitor, scheduler });

    await app.request('/api/crawl/run', { method: 'POST' });
    const second = await app.request('/api/crawl/run', { method: 'POST' });

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_running' });
    expect(run).toHaveBeenCalledTimes(1);
    resolve(undefined);
  });

  it('без планировщика отвечает 503 и объясняет причину', async () => {
    const app = createApp({ db: handle.db, monitor, scheduler: null });

    const res = await app.request('/api/crawl/run', { method: 'POST' });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'scheduler_disabled' });
  });
});

/** Читает один кадр потока и отдаёт его текстом. */
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return value ? new TextDecoder().decode(value) : '';
}

/** Тело SSE-ответа всегда есть; пусто — это провал теста, а не норма. */
function bodyReader(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error('поток событий не открылся');
  return res.body.getReader();
}

describe('GET /api/events (SSE)', () => {
  it('первым кадром отдаёт текущий снимок состояния', async () => {
    monitor.started('crawler');
    const app = createApp({ db: handle.db, monitor, scheduler: null });

    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = bodyReader(res);
    const text = await readFrame(reader);

    expect(text).toContain('status');
    expect(text).toContain('crawler');
    await reader.cancel();
  });

  it('присылает событие, случившееся после подписки', async () => {
    const app = createApp({ db: handle.db, monitor, scheduler: null });
    const res = await app.request('/api/events');
    const reader = bodyReader(res);
    await readFrame(reader); // снимок

    monitor.log('crawler', 'info', 'свежая новость');

    expect(await readFrame(reader)).toContain('свежая новость');
    await reader.cancel();
  });
});

describe('адрес следующего захода', () => {
  it('фаза landing ведёт на раздел New Releases (ТЗ п.1)', () => {
    expect(NEW_RELEASES_PAGE_URL).toBe('https://www.metacritic.com/game/');
  });

  it('первая страница списка — без номера в адресе', () => {
    expect(browseListPageUrl(1)).toBe(
      'https://www.metacritic.com/browse/game/all/all/all-time/new/',
    );
  });

  it('очередная страница списка всех игр, сортировка «Новые» (ТЗ п.2)', () => {
    expect(browseListPageUrl(5)).toBe(
      'https://www.metacritic.com/browse/game/all/all/all-time/new/?page=5',
    );
  });
});
