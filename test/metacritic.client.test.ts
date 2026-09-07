import { describe, expect, it, vi } from 'vitest';
import { HttpClient, RateLimiter } from '../src/clients/http.js';
import {
  DEFAULT_MAX_REVIEWS,
  MetacriticClient,
} from '../src/clients/metacritic/index.js';

/** Клиент проверяется на подменённом fetch: сети нет, время не идёт. */
function clientWith(
  pages: Record<string, unknown>[],
  maxReviews?: Partial<Record<'critic' | 'user', number>>,
) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input) => {
    // Клиент всегда зовёт fetch со строковым URL; Request/URL сюда не приходят.
    calls.push(input instanceof URL ? input.href : (input as string));
    const body = pages[Math.min(i++, pages.length - 1)];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  const http = new HttpClient({
    userAgent: 'test/1.0',
    minIntervalMs: 0,
    limiter: new RateLimiter(0, () => 0, () => Promise.resolve()),
    fetchImpl,
  });

  return {
    client: new MetacriticClient(maxReviews ? { http, maxReviews } : { http }),
    calls,
  };
}

/** Ответ со списком отзывов: `n` штук из общего числа `total`. */
function reviewPage(n: number, total: number, offset = 0): Record<string, unknown> {
  return {
    data: {
      totalResults: total,
      items: Array.from({ length: n }, (_, k) => ({
        id: `id-${offset + k}`,
        quote: `отзыв ${offset + k}`,
        score: 8,
        date: '2026-09-01',
        author: `автор${offset + k}`,
      })),
    },
  };
}

const limitOf = (url: string) => Number(new URL(url).searchParams.get('limit'));

describe('пагинация отзывов', () => {
  it('пользователей забирает одним запросом: источник соблюдает limit', async () => {
    const { client, calls } = clientWith([reviewPage(30, 30)]);

    const reviews = await client.listReviews('user', 'g', { platform: 'pc' });

    expect(reviews).toHaveLength(DEFAULT_MAX_REVIEWS.user);
    expect(calls).toHaveLength(1);
    expect(limitOf(calls[0] ?? '')).toBe(DEFAULT_MAX_REVIEWS.user);
  });

  it('критиков — по 10 за раз, потому что больше источник не отдаёт', async () => {
    const pages = Array.from({ length: 4 }, (_, p) => reviewPage(10, 93, p * 10));
    const { client, calls } = clientWith(pages);

    const reviews = await client.listReviews('critic', 'g', { platform: 'ps5' });

    // 40 критиков (§4.1) при потолке источника 10 — ровно четыре запроса.
    expect(reviews).toHaveLength(DEFAULT_MAX_REVIEWS.critic);
    expect(calls).toHaveLength(4);
    expect(calls.every((u) => limitOf(u) === 10)).toBe(true);
  });

  it('останавливается, когда отзывы кончились, не добирая до потолка', async () => {
    const { client, calls } = clientWith([reviewPage(3, 3)]);

    const reviews = await client.listReviews('critic', 'g');

    expect(reviews).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it('дедуплицирует пересекающиеся страницы: порядок у источника нестабилен', async () => {
    // Обе страницы отдают те же id — источник вправе так сделать (§6).
    const { client } = clientWith([reviewPage(10, 93, 0), reviewPage(10, 93, 0)]);

    const reviews = await client.listReviews('critic', 'g');

    expect(new Set(reviews.map((r) => r.externalId)).size).toBe(reviews.length);
  });

  it('потолок переопределяется, и это видно в запросе', async () => {
    const { client, calls } = clientWith([reviewPage(5, 100)], { user: 5 });

    const reviews = await client.listReviews('user', 'g');

    expect(reviews).toHaveLength(5);
    expect(limitOf(calls[0] ?? '')).toBe(5);
  });

  it('переопределение одного вида не трогает другой', async () => {
    const { client, calls } = clientWith([reviewPage(10, 100)], { user: 5 });

    await client.listReviews('critic', 'g');

    // Критикам остался дефолт §4.1 — 40 при шаге 10.
    expect(calls).toHaveLength(DEFAULT_MAX_REVIEWS.critic / 10);
  });
});

describe('тональность в запросе отзывов', () => {
  it('фильтр доходит до источника и проставляется отзывам', async () => {
    const { client, calls } = clientWith([reviewPage(2, 2)]);

    const reviews = await client.listReviews('user', 'g', { sentiment: 'neutral' });

    expect(new URL(calls[0] ?? '').searchParams.get('filterBySentiment')).toBe('neutral');
    // `neutral` источника — это `mixed` в словаре схемы.
    expect(reviews.every((r) => r.sentiment === 'mixed')).toBe(true);
  });

  it('без фильтра тональность остаётся null, а не догадкой', async () => {
    const { client } = clientWith([reviewPage(2, 2)]);

    const reviews = await client.listReviews('user', 'g');

    expect(reviews.every((r) => r.sentiment === null)).toBe(true);
  });
});
