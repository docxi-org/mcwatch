import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError, RateLimiter } from '../src/clients/http.js';
import {
  browsePageUrl,
  imageUrl,
  newReleasesUrl,
  reviewListUrl,
  scoreStatsUrl,
} from '../src/clients/metacritic/endpoints.js';
import { metacriticUserAgent } from '../src/clients/metacritic/index.js';
import { SERVICE_VERSION } from '../src/config/service.js';

/** Часы и сон подменяются: тест не ждёт реального времени. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('выдерживает интервал между задачами', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.now, clock.sleep);
    const starts: number[] = [];
    const task = () => {
      starts.push(clock.now());
      return Promise.resolve('ok');
    };

    await Promise.all([limiter.run(task), limiter.run(task), limiter.run(task)]);

    expect(starts).toEqual([0, 1000, 2000]);
  });

  it('не ждёт, если интервал уже прошёл сам по себе', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.now, clock.sleep);

    await limiter.run(() => Promise.resolve(1));
    clock.advance(5000);
    await limiter.run(() => Promise.resolve(2));

    expect(clock.sleeps).toEqual([]);
  });

  it('упавшая задача не рвёт очередь', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.now, clock.sleep);

    const failed = limiter.run(() => Promise.reject(new Error('нет')));
    await expect(failed).rejects.toThrow('нет');
    await expect(limiter.run(() => Promise.resolve('жив'))).resolves.toBe('жив');
  });

  it('соблюдает порядок постановки', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(10, clock.now, clock.sleep);
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        limiter.run(() => {
          order.push(n);
          return Promise.resolve(n);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3, 4]);
  });
});

describe('HttpClient', () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  function client(fetchImpl: typeof fetch, over: Partial<{ maxAttempts: number }> = {}) {
    const clock = fakeClock();
    return new HttpClient({
      userAgent: 'test/1.0',
      minIntervalMs: 0,
      retryBaseMs: 1,
      sleep: clock.sleep,
      limiter: new RateLimiter(0, clock.now, clock.sleep),
      fetchImpl,
      ...over,
    });
  }

  it('шлёт User-Agent и разбирает JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok({ a: 1 }));

    await expect(client(fetchImpl).getJson('https://x/y')).resolves.toEqual({ a: 1 });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      'user-agent': 'test/1.0',
    });
  });

  it('повторяет 500 и возвращает успех следующей попытки', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(ok({ ok: true }));

    await expect(client(fetchImpl).getJson('https://x/y')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('не повторяет 404 — это не временная ошибка', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response('nope', { status: 404 })));

    await expect(client(fetchImpl).getJson('https://x/y')).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('сдаётся после исчерпания попыток', async () => {
    // Тело Response читается один раз — на каждую попытку нужен новый объект.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response('boom', { status: 503 })));

    await expect(
      client(fetchImpl, { maxAttempts: 3 }).getJson('https://x/y'),
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('построители URL', () => {
  it('New Releases отличается от browse ровно параметром metaScoreMin', () => {
    const news = new URL(newReleasesUrl());
    const browse = new URL(browsePageUrl(1, 20));

    expect(news.searchParams.get('metaScoreMin')).toBe('1');
    expect(browse.searchParams.get('metaScoreMin')).toBeNull();
    for (const key of ['sortBy', 'offset', 'limit', 'mcoTypeId']) {
      expect(news.searchParams.get(key)).toBe(browse.searchParams.get(key));
    }
  });

  it('страницы browse считаются от 1 и сдвигают offset на 24', () => {
    expect(new URL(browsePageUrl(1)).searchParams.get('offset')).toBe('0');
    expect(new URL(browsePageUrl(3)).searchParams.get('offset')).toBe('48');
    expect(() => browsePageUrl(0)).toThrow(RangeError);
  });

  it('платформа для оценок идёт сегментом пути, а не параметром', () => {
    expect(scoreStatsUrl('user', 'g', 'pc')).toContain('/games/g/platform/pc/stats/web');
    expect(new URL(scoreStatsUrl('user', 'g', 'pc')).searchParams.get('platform')).toBeNull();
    expect(scoreStatsUrl('user', 'g')).toContain('/games/g/stats/web');
  });

  it('фильтр по тональности попадает в запрос отзывов', () => {
    const url = new URL(reviewListUrl('user', 'g', { sentiment: 'negative' }));

    expect(url.searchParams.get('filterBySentiment')).toBe('negative');
  });

  it('apiKey не утекает ни в один запрос', () => {
    const urls = [
      newReleasesUrl(),
      browsePageUrl(2),
      scoreStatsUrl('critic', 'g', 'pc'),
      reviewListUrl('critic', 'g'),
    ];

    for (const u of urls) expect(u).not.toContain('apiKey');
  });

  it('обложка без данных остаётся null', () => {
    expect(imageUrl(null, '/x.jpg')).toBeNull();
    expect(imageUrl('catalog', null)).toBeNull();
  });

  it('User-Agent называет проект, версию и контакт (правило Metacritic)', () => {
    const ua = metacriticUserAgent('me@example.com');

    expect(ua).toContain('mcwatch');
    expect(ua).toContain(SERVICE_VERSION);
    expect(ua).toContain('me@example.com');
  });

  it('версия сервиса не разъезжается с package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };

    expect(SERVICE_VERSION).toBe(pkg.version);
  });
});
