import { setTimeout as delay } from 'node:timers/promises';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embedMany, generateText, Output } from 'ai';
import { z } from 'zod';
import { env } from '../config/env.js';
import { SERVICE_NAME } from '../config/service.js';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  SUMMARY_LIMITS,
  SUMMARY_MODEL,
} from '../config/models.js';
import type { Review, ReviewKind } from './metacritic/index.js';

/**
 * Единственная дверь к LLM. Всё — через один ключ OpenRouter и Vercel AI SDK
 * (CLAUDE.md, «Зафиксированные решения»). Модель делает ровно три вещи, и эта
 * первая: резюме отзывов.
 */

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'Нет OPENROUTER_API_KEY. Скопируйте .env.example в .env и впишите ключ — ' +
        'в репозитории ключей нет.',
    );
    this.name = 'MissingApiKeyError';
  }
}

export const summarySchema = z.object({
  likes: z
    .array(z.string().max(SUMMARY_LIMITS.maxPointChars))
    .max(SUMMARY_LIMITS.maxPoints)
    .describe('Что нравится. Короткие фразы, без повторов.'),
  dislikes: z
    .array(z.string().max(SUMMARY_LIMITS.maxPointChars))
    .max(SUMMARY_LIMITS.maxPoints)
    .describe('Что не нравится. Короткие фразы, без повторов.'),
  summary: z
    .string()
    .max(SUMMARY_LIMITS.maxSummaryChars)
    .describe('Общее впечатление, 2–3 предложения.'),
});

export type ReviewSummary = z.infer<typeof summarySchema>;

const KIND_NAME: Record<ReviewKind, string> = {
  critic: 'профессиональных рецензентов',
  user: 'игроков',
};

const SYSTEM_PROMPT = [
  'Ты обобщаешь отзывы об играх для русскоязычного каталога.',
  'Пиши ПО-РУССКИ независимо от языка отзывов.',
  'Опирайся только на то, что сказано в отзывах: ничего не додумывай и не',
  'добавляй знаний об игре со стороны. Если о чём-то не сказано — не пиши об этом.',
  `Каждый пункт — короткая фраза до ${SUMMARY_LIMITS.maxPointChars} знаков, без повторов между пунктами.`,
  'Название игры не переводи.',
].join(' ');

export interface SummarizeInput {
  title: string;
  kind: ReviewKind;
  reviews: Review[];
}

export interface OpenRouterClientOptions {
  apiKey?: string | undefined;
  model?: string;
  embeddingModel?: string;
  /** Таймаут одной попытки, мс. */
  timeoutMs?: number;
  /** Число попыток, включая первую. */
  maxAttempts?: number;
}

/**
 * Таймаут на ОДНУ попытку. Общий бюджет на все попытки не годится: первая же
 * зависшая попытка съедала его целиком, и повторов не случалось — на этом
 * одна игра падала стабильно, хотя вручную считалась за 5 секунд.
 * Резюме укладывается в 5–10 с, тридцати хватает с запасом.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Сколько всего попыток, включая первую. */
const DEFAULT_MAX_ATTEMPTS = 3;

export class OpenRouterClient {
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly provider: ReturnType<typeof createOpenRouter>;

  constructor(opts: OpenRouterClientOptions = {}) {
    const apiKey = opts.apiKey ?? env.OPENROUTER_API_KEY;
    if (!apiKey) throw new MissingApiKeyError();

    this.model = opts.model ?? SUMMARY_MODEL;
    this.embeddingModel = opts.embeddingModel ?? EMBEDDING_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.provider = createOpenRouter({
      apiKey,
      // OpenRouter просит представляться: по этим заголовкам он атрибутирует
      // трафик приложения.
      headers: { 'X-Title': SERVICE_NAME },
    });
  }

  /**
   * Резюме одной группы отзывов. Считается по отзывам всех платформ разом —
   * решение владельца 07.09.2026, см. §4.1.
   */
  async summarizeReviews(input: SummarizeInput): Promise<ReviewSummary> {
    const corpus = input.reviews
      .map((r, i) => {
        const score = r.score === null ? 'без оценки' : `${r.score}/${r.scoreMax}`;
        const text = r.text.slice(0, SUMMARY_LIMITS.maxReviewChars);
        return `[${i + 1}] ${score}: ${text}`;
      })
      .join('\n');

    const prompt = `Отзывы ${KIND_NAME[input.kind]} об игре «${input.title}»:\n\n${corpus}`;
    return this.withRetries(() => this.generateOnce(prompt));
  }

  /**
   * Повтор своими руками, а не через `maxRetries` SDK: у каждой попытки должен
   * быть свой таймаут. Один сигнал на все попытки означает, что первая же
   * зависшая съедает весь бюджет и повторов не происходит — на этом одна игра
   * падала стабильно, хотя вручную считалась за пять секунд.
   */
  private async withRetries<T>(attempt: () => Promise<T>): Promise<T> {
    let lastErr: unknown;

    for (let i = 1; i <= this.maxAttempts; i++) {
      try {
        return await attempt();
      } catch (err) {
        lastErr = err;
        if (i === this.maxAttempts) break;
        await delay(500 * 2 ** (i - 1));
      }
    }

    throw lastErr;
  }

  /**
   * Эмбеддинги пачкой. Размерность усечённая: модель матрёшечная, 1536 из
   * родных 2560 (§4). Порядок ответа соответствует порядку входа.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const { embeddings } = await this.withRetries(() =>
      embedMany({
        model: this.provider.textEmbeddingModel(this.embeddingModel),
        values: texts,
        providerOptions: { openrouter: { dimensions: EMBEDDING_DIMENSIONS } },
        // Тот же порядок, что и у резюме: свой таймаут на каждую попытку.
        abortSignal: AbortSignal.timeout(this.timeoutMs),
        maxRetries: 0,
      }),
    );

    if (embeddings.length !== texts.length) {
      throw new Error(
        `OpenRouter вернул ${embeddings.length} эмбеддингов на ${texts.length} текстов`,
      );
    }
    return embeddings.map((e) => Float32Array.from(e));
  }

  private async generateOnce(prompt: string): Promise<ReviewSummary> {
    const { output } = await generateText({
      model: this.provider.chat(this.model),
      output: Output.object({ schema: summarySchema }),
      system: SYSTEM_PROMPT,
      prompt,
      // Рассуждения выключены намеренно: задача не требует их, а платить за
      // них пришлось бы (§7).
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
      // Свежий сигнал на каждую попытку — в этом весь смысл своего повтора.
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      // Повторы делает `withRetries`, SDK их дублировать не должен.
      maxRetries: 0,
    });

    return output;
  }
}
