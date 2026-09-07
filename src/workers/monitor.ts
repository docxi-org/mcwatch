import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { eventsLog, workerStatus } from '../db/schema.js';

/**
 * Наблюдение за воркерами — `docs/ARCHITECTURE.md` §3 и ТЗ, доп. часть 2.
 * Воркеры сюда только докладывают; сами в таблицы состояния они не пишут,
 * иначе сбор данных знал бы про мониторинг.
 */

export type WorkerState = 'idle' | 'running' | 'error';
export type EventLevel = 'info' | 'warn' | 'error';

/** Потолок журнала из §3: лишнее срезается при записи. */
export const EVENTS_LOG_CAP = 5000;

export interface WorkerEvent {
  id: number;
  ts: string;
  worker: string;
  level: EventLevel;
  message: string;
  data: unknown;
}

export interface WorkerStatusDto {
  worker: string;
  state: WorkerState;
  currentItem: string | null;
  processedTotal: number;
  failedTotal: number;
  lastRunAt: string | null;
  lastError: string | null;
}

/**
 * Что уходит подписчикам. Событие журнала durable и хранится в базе; снимок
 * состояния — нет: это ход работы, который интересен, только пока он идёт.
 */
export type MonitorMessage =
  | { kind: 'event'; event: WorkerEvent }
  | { kind: 'status'; workers: WorkerStatusDto[] };

export type MonitorListener = (message: MonitorMessage) => void;

/**
 * Докладчик, который получают воркеры. Отдельный интерфейс, чтобы воркер
 * зависел от узкого набора действий, а не от всего монитора.
 */
export interface Reporter {
  started: (worker: string) => void;
  item: (worker: string, name: string) => void;
  processed: (worker: string, n?: number) => void;
  failed: (worker: string, n?: number) => void;
  finished: (worker: string, error?: string | null) => void;
  log: (worker: string, level: EventLevel, message: string, data?: unknown) => void;
}

/** Докладчик, который ничего не делает: воркеры работают и без мониторинга. */
export const nullReporter: Reporter = {
  started: () => undefined,
  item: () => undefined,
  processed: () => undefined,
  failed: () => undefined,
  finished: () => undefined,
  log: () => undefined,
};

export class Monitor implements Reporter {
  private readonly listeners = new Set<MonitorListener>();
  private writes = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Доклад воркеров ──────────────────────────────────────────────────────

  started(worker: string): void {
    this.upsert(worker, { state: 'running', currentItem: null, lastRunAt: this.now() });
    this.log(worker, 'info', 'воркер начал работу');
    this.broadcastStatus();
  }

  item(worker: string, name: string): void {
    this.upsert(worker, { currentItem: name });
    // Обход длится минуты, и без этого поток молчал бы всё это время.
    this.broadcastStatus();
  }

  processed(worker: string, n = 1): void {
    this.bump(worker, 'processed', n);
    this.broadcastStatus();
  }

  failed(worker: string, n = 1): void {
    this.bump(worker, 'failed', n);
    this.broadcastStatus();
  }

  finished(worker: string, error: string | null = null): void {
    this.upsert(worker, {
      state: error ? 'error' : 'idle',
      currentItem: null,
      lastError: error,
    });
    this.log(
      worker,
      error ? 'error' : 'info',
      error ? `воркер завершился с ошибкой: ${error}` : 'воркер закончил работу',
    );
    this.broadcastStatus();
  }

  log(worker: string, level: EventLevel, message: string, data?: unknown): void {
    const ts = this.now();
    const row = this.db
      .insert(eventsLog)
      .values({ ts, worker, level, message, data: data ?? null })
      .returning({ id: eventsLog.id })
      .get();

    this.rotate();

    const event: WorkerEvent = {
      id: row.id,
      ts: ts.toISOString(),
      worker,
      level,
      message,
      data: data ?? null,
    };
    this.emit({ kind: 'event', event });
  }

  private broadcastStatus(): void {
    if (this.listeners.size === 0) return;
    this.emit({ kind: 'status', workers: this.statuses() });
  }

  private emit(message: MonitorMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  // ── Подписка ─────────────────────────────────────────────────────────────

  /** @returns функция отписки */
  subscribe(listener: MonitorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  // ── Чтение ───────────────────────────────────────────────────────────────

  statuses(): WorkerStatusDto[] {
    return this.db
      .select()
      .from(workerStatus)
      .orderBy(asc(workerStatus.worker))
      .all()
      .map((r) => ({
        worker: r.worker,
        state: r.state,
        currentItem: r.currentItem,
        processedTotal: r.processedTotal,
        failedTotal: r.failedTotal,
        lastRunAt: r.lastRunAt?.toISOString() ?? null,
        lastError: r.lastError,
      }));
  }

  /** Последние события, свежие первыми. */
  recentEvents(limit = 50): WorkerEvent[] {
    return this.db
      .select()
      .from(eventsLog)
      .orderBy(sql`${eventsLog.id} DESC`)
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.id,
        ts: r.ts.toISOString(),
        worker: r.worker,
        level: r.level as EventLevel,
        message: r.message,
        data: r.data ?? null,
      }));
  }

  // ── Внутреннее ───────────────────────────────────────────────────────────

  private upsert(
    worker: string,
    patch: Partial<{
      state: WorkerState;
      currentItem: string | null;
      lastRunAt: Date;
      lastError: string | null;
    }>,
  ): void {
    this.db
      .insert(workerStatus)
      .values({ worker, ...patch })
      .onConflictDoUpdate({ target: workerStatus.worker, set: patch })
      .run();
  }

  /**
   * Счётчики накопительные: их растят прибавкой, а не перезаписью, — иначе
   * «обработано за всё время» превратилось бы в «за последний вызов».
   */
  private bump(worker: string, which: 'processed' | 'failed', n: number): void {
    const isProcessed = which === 'processed';
    this.db
      .insert(workerStatus)
      .values({
        worker,
        processedTotal: isProcessed ? n : 0,
        failedTotal: isProcessed ? 0 : n,
      })
      .onConflictDoUpdate({
        target: workerStatus.worker,
        set: isProcessed
          ? { processedTotal: sql`${workerStatus.processedTotal} + ${n}` }
          : { failedTotal: sql`${workerStatus.failedTotal} + ${n}` },
      })
      .run();
  }

  /**
   * Срезает журнал до потолка. Считать каждую запись дорого и не нужно —
   * проверяем раз в сотню вставок, потолок мягкий по замыслу.
   */
  private rotate(): void {
    if (++this.writes % 100 !== 0) return;

    this.db
      .delete(eventsLog)
      .where(
        sql`${eventsLog.id} <= (
          SELECT id FROM ${eventsLog} ORDER BY id DESC LIMIT 1 OFFSET ${EVENTS_LOG_CAP}
        )`,
      )
      .run();
  }

  /** Принудительная обрезка — нужна тестам и обслуживанию. */
  rotateNow(): number {
    return this.db
      .delete(eventsLog)
      .where(
        sql`${eventsLog.id} <= (
          SELECT id FROM ${eventsLog} ORDER BY id DESC LIMIT 1 OFFSET ${EVENTS_LOG_CAP}
        )`,
      )
      .run().changes;
  }

  /** Сброс счётчиков воркера. Для обслуживания, в обычном ходе не нужен. */
  reset(worker: string): void {
    this.db.delete(workerStatus).where(eq(workerStatus.worker, worker)).run();
  }
}
