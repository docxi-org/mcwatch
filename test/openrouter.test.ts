import { describe, expect, it, vi } from 'vitest';
import { MissingApiKeyError, OpenRouterClient } from '../src/clients/openrouter.js';

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

    await expect(client.summarizeReviews(input)).resolves.toEqual({
      likes: ['раз'],
      dislikes: ['два'],
      summary: 'итог',
    });
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
    await expect(client.summarizeReviews(input)).resolves.toMatchObject({
      summary: 'итог',
    });
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
