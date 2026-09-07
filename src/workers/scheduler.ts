import type { Logger } from 'pino';
import { componentLogger } from '../config/logger.js';

/**
 * Планировщик внутри того же процесса, что и HTTP (CLAUDE.md, «Зафиксированные
 * решения»). Раз в час прогоняет цикл: обход → резюме → эмбеддинги. Этапы идут
 * строго по порядку, и сбой одного не отменяет следующие — данные всё равно
 * полезны по частям.
 */

export interface Stage {
  name: string;
  run: () => Promise<void>;
}

export interface SchedulerOptions {
  stages: Stage[];
  intervalMs: number;
  /** Когда обход был в последний раз; `null` — никогда. */
  lastRunAt: () => Date | null;
  now?: () => Date;
  log?: Logger;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
}

export interface CycleResult {
  started: Date;
  finished: Date;
  stages: { name: string; ok: boolean; error?: string; ms: number }[];
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly now: () => Date;
  private readonly log: Logger;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (t: NodeJS.Timeout) => void;

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? componentLogger('scheduler');
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => {
      clearTimeout(t);
    });
  }

  /** Идёт ли цикл прямо сейчас. Понадобится G5 для кнопки запуска. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Сколько ждать до первого цикла. Сразу — только если с прошлого обхода
   * прошёл интервал: иначе перезапуск контейнера в цикле означал бы шквал
   * запросов к источнику.
   */
  delayBeforeFirstRun(): number {
    const last = this.opts.lastRunAt();
    if (!last) return 0;
    const elapsed = this.now().getTime() - last.getTime();
    return Math.max(0, this.opts.intervalMs - elapsed);
  }

  start(): void {
    this.stopped = false;
    const delay = this.delayBeforeFirstRun();
    this.log.info(
      { delayMs: delay, intervalMs: this.opts.intervalMs },
      'планировщик запущен',
    );
    this.schedule(delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      void this.runCycle().finally(() => {
        this.schedule(this.opts.intervalMs);
      });
    }, delayMs);
  }

  /**
   * Один цикл. Повторный вызов во время работы предыдущего ничего не делает и
   * говорит об этом — иначе два обхода полезли бы к Metacritic одновременно.
   *
   * @returns результат цикла либо `null`, если цикл уже идёт
   */
  async runCycle(): Promise<CycleResult | null> {
    if (this.running) {
      this.log.warn('цикл уже идёт, повторный запуск пропущен');
      return null;
    }

    this.running = true;
    const started = this.now();
    const stages: CycleResult['stages'] = [];

    try {
      for (const stage of this.opts.stages) {
        const t0 = this.now().getTime();
        try {
          await stage.run();
          stages.push({ name: stage.name, ok: true, ms: this.now().getTime() - t0 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          stages.push({
            name: stage.name,
            ok: false,
            error: message,
            ms: this.now().getTime() - t0,
          });
          // Следующий этап всё равно выполняется: резюме нужны и по тем играм,
          // что уже лежат в базе, даже если обход сегодня не удался.
          this.log.warn({ err, stage: stage.name }, 'этап цикла не удался');
        }
      }
    } finally {
      this.running = false;
    }

    const result: CycleResult = { started, finished: this.now(), stages };
    this.log.info(
      { stages: stages.map((s) => `${s.name}:${s.ok ? 'ok' : 'fail'}`) },
      'цикл завершён',
    );
    return result;
  }
}
