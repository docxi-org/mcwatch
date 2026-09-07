import { setTimeout as delay } from 'node:timers/promises';

/**
 * Общий транспорт для внешних источников. Бизнес-логика в сеть напрямую не
 * ходит (CLAUDE.md, «Правила кода») — только через клиентов поверх этого слоя.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} на ${url}`);
    this.name = 'HttpError';
  }
}

/** Ошибки, которые имеет смысл повторить: сеть, таймаут, 429 и 5xx. */
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true;
}

/**
 * Последовательная очередь с минимальным интервалом между стартами задач.
 * Metacritic — ≤1 запрос/с (CLAUDE.md), поэтому именно очередь, а не семафор:
 * параллельных запросов к источнику быть не должно.
 */
export class RateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  /** До первого запроса ждать нечего: интервал считается между стартами. */
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => delay(ms),
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const scheduled = this.tail.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return task();
    });
    // Хвост очереди не должен рваться из-за упавшей задачи: следующий в
    // очереди обязан стартовать в любом случае.
    this.tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }
}

export interface HttpClientOptions {
  userAgent: string;
  /** Минимальный интервал между запросами, мс. */
  minIntervalMs: number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Базовая пауза перед повтором; растёт экспоненциально. */
  retryBaseMs?: number;
  limiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpClient {
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = opts.limiter ?? new RateLimiter(opts.minIntervalMs);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
  }

  /** GET с разбором JSON. Разбор формы ответа — забота вызывающего клиента. */
  async getJson(url: string): Promise<unknown> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        // Пауза между попытками — внутри очереди, чтобы повтор тоже
        // соблюдал rate-limit источника.
        return await this.limiter.run(() => this.fetchOnce(url));
      } catch (err) {
        lastErr = err;
        if (attempt === this.maxAttempts || !isRetryable(err)) throw err;
        await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
      }
    }

    throw lastErr;
  }

  private async fetchOnce(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      headers: { 'user-agent': this.opts.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new HttpError(res.status, url, (await res.text()).slice(0, 500));
    }
    return res.json();
  }
}
