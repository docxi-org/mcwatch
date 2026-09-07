import { describe, expect, it, vi } from 'vitest';
import { MissingApiKeyError, OpenRouterClient } from '../src/clients/openrouter.js';
import { EMBEDDING_DIMENSIONS } from '../src/config/models.js';
import { truncateEmbedding } from '../src/clients/openrouter.js';

/**
 * Клиент проверяется через подменённый `fetch`: сети нет. Интересует не ответ
 * модели, а поведение обвязки — таймаут на попытку и повторы.
 */

const OK_BODY = {
  id: 'x',
  object: 'chat.completion',
  created: 0,
  model: 'test',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          likes: ['раз'],
          dislikes: ['два'],
          summary: 'итог',
        }),
      },
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const ok = () =>
  new Response(JSON.stringify(OK_BODY), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const input = {
  title: 'Игра',
  kind: 'user' as const,
  reviews: [
    {
      externalId: 'r1',
      kind: 'user' as const,
      text: 'хорошо',
      score: 9,
      scoreMax: 10,
      author: null,
      date: null,
      url: null,
      platform: null,
      sentiment: null,
    },
  ],
};

describe('OpenRouterClient', () => {
  it('с незаполненным ключом падает внятно, а не лезет в сеть', () => {
    // Ровно то, что получится, если скопировать .env.example и не вписать ключ.
    expect(() => new OpenRouterClient({ apiKey: '' })).toThrow(MissingApiKeyError);
  });

  it('разбирает структурированный ответ по схеме', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    vi.stubGlobal('fetch', fetchImpl);

    const client = new OpenRouterClient({ apiKey: 'k' });

    const call = await client.summarizeReviews(input);

    expect(call.value).toEqual({ likes: ['раз'], dislikes: ['два'], summary: 'итог' });
    // Метрики вызова нужны карточке конвейера — они приходят тем же ответом.
    expect(call.meta).toMatchObject({ attempts: 1 });
    // В `prompt` лежит то самое сырьё — отзывы, ушедшие в модель.
    expect(call.meta.prompt).toContain('Отзывы');
  });

  it('каждая попытка получает СВОЙ таймаут, а не общий бюджет', async () => {
    const signals: AbortSignal[] = [];
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_u, init) => {
      signals.push(init?.signal as AbortSignal);
      call++;
      // Первая попытка «зависает» до собственного таймаута.
      if (call === 1) {
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => {
            rej(new Error('The operation was aborted due to timeout'));
          });
        });
      }
      return Promise.resolve(ok());
    });
    vi.stubGlobal('fetch', fetchImpl);

    const client = new OpenRouterClient({ apiKey: 'k', timeoutMs: 30, maxAttempts: 3 });

    // Раз вторая попытка успела — значит бюджет первой её не съел.
    const result = await client.summarizeReviews(input);

    expect(result.value).toMatchObject({ summary: 'итог' });
    // Число попыток попадает в метрики: карточка конвейера показывает и это.
    expect(result.meta.attempts).toBe(2);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('после исчерпания попыток отдаёт последнюю ошибку', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.reject(new Error('провайдер лёг')));
    vi.stubGlobal('fetch', fetchImpl);

    const client = new OpenRouterClient({ apiKey: 'k', timeoutMs: 50, maxAttempts: 2 });

    await expect(client.summarizeReviews(input)).rejects.toThrow(/провайдер лёг/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('эмбеддинги', () => {
  it('усекаются до объявленной размерности своими руками', () => {
    // Провайдер отдаёт родные 2560 — ровно это показала карточка конвейера
    // 07.09.2026, хотя `providerOptions.dimensions` просил 1536.
    const native = Array.from({ length: 2560 }, (_, i) => i / 2560);

    const cut = truncateEmbedding(native);

    expect(cut).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(cut[0]).toBe(0);
    expect(cut[EMBEDDING_DIMENSIONS - 1]).toBeCloseTo(native[EMBEDDING_DIMENSIONS - 1] ?? 0, 6);
  });

  it('короткий вектор остаётся как есть, а не добивается нулями', () => {
    expect(truncateEmbedding([1, 2, 3])).toHaveLength(3);
  });
});
