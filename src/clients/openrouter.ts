import { setTimeout as delay } from 'node:timers/promises';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embedMany, generateText, Output } from 'ai';
import { z } from 'zod';
import { env } from '../config/env.js';
import { SERVICE_NAME } from '../config/service.js';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  LETSPLAY_LIMITS,
  LETSPLAY_MODEL,
  SUMMARY_LIMITS,
  SUMMARY_MODEL,
  estimateCostUsd,
} from '../config/models.js';
import type { Review, ReviewKind } from './metacritic/index.js';

/**
 * Единственная дверь к LLM. Всё — через один ключ OpenRouter и Vercel AI SDK
 * (CLAUDE.md, «Зафиксированные решения»). Здесь четыре задачи: резюме отзывов,
 * эмбеддинги, судья «та ли игра» и заключение по летсплею.
 *
 * Судья добавлен решением владельца 07.09.2026 сверх трёх задач из CLAUDE.md:
 * тождество игры — семантика, и два алгоритмических отсева на ней провалились
 * (`docs/ARCHITECTURE.md` §6).
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

/**
 * Суждение о том, та ли это игра. Отдельный вызов, а не догадка кода:
 * тождество игры — семантика, и алгоритмические отсевы на ней провалились
 * дважды (§6). `confidence: low` трактуется как сомнение, не как приговор.
 */
export const videoMatchSchema = z.object({
  matches: z.boolean().describe('Играют ли в ролике именно в эту игру'),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().max(200).describe('Кратко по-русски, на чём основан вывод'),
});

export type VideoMatch = z.infer<typeof videoMatchSchema>;

export const letsplayConclusionSchema = z.object({
  conclusion: z
    .string()
    .max(LETSPLAY_LIMITS.maxConclusionChars)
    .describe('Пересказ впечатления автора ролика, 3–5 предложений'),
  highlights: z
    .array(z.string().max(LETSPLAY_LIMITS.maxPointChars))
    .max(LETSPLAY_LIMITS.maxPoints)
    .describe('Что автор отметил особо'),
  vibe: z
    .enum(['positive', 'mixed', 'negative'])
    .describe('Общее отношение автора к игре'),
});

export type LetsplayConclusion = z.infer<typeof letsplayConclusionSchema>;

export interface VideoInfo {
  title: string;
  channel: string | null;
}

export interface GameInfo {
  title: string;
  developer: string | null;
  genres: string[];
  description: string | null;
}

const JUDGE_PROMPT = [
  'Ты решаешь ровно один вопрос: играют ли в ролике в ТУ ЖЕ САМУЮ игру,',
  'что описана в карточке. Только тождество игры, ничего больше.',
  'matches=false, если это другая игра — пусть даже похожая по названию или',
  'из той же серии.',
  'Жанр, разработчик и описание даны для опознания, а НЕ как требования:',
  'расхождение жанра или описания само по себе не делает ролик чужим, эти',
  'поля бывают неточными.',
  'Опирайся прежде всего на речь автора: называет ли он игру, о чём говорит.',
  'Если в речи явно называют другую игру — matches=false.',
  'confidence=low, если по расшифровке нельзя судить уверенно.',
  'reason — по-русски, кратко.',
].join(' ');

const CONCLUSION_PROMPT = [
  'Ты пересказываешь, что автор летсплея говорит об игре.',
  'Пиши ПО-РУССКИ независимо от языка ролика.',
  'Опирайся только на речь автора: ничего не додумывай и не добавляй знаний об',
  'игре со стороны. Это пересказ ЕГО впечатления, а не твой обзор.',
  'Если автор о чём-то не говорил — не пиши об этом.',
  `highlights — до ${LETSPLAY_LIMITS.maxPoints} коротких фраз, что он отметил особо.`,
  'vibe — его общее отношение к игре.',
].join(' ');

function gameBlock(game: GameInfo): string {
  return [
    `Название: ${game.title}`,
    `Разработчик: ${game.developer ?? '—'}`,
    `Жанры: ${game.genres.join(', ') || '—'}`,
    `Описание: ${game.description ?? '—'}`,
  ].join('\n');
}

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

/** Расход токенов, приведённый к одной форме для чата и эмбеддингов. */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Метрики одного вызова. Нужны карточке конвейера: она показывает не только
 * ответ, но и то, как он был получен (`docs/ARCHITECTURE.md` §10).
 */
export interface CallMeta {
  model: string;
  /** Сколько попыток понадобилось, включая удачную. */
  attempts: number;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Оценка по прайсу из конфига, не факт от провайдера. */
  costUsd: number | null;
  /** Постоянная часть запроса. */
  system: string;
  /** Переменная часть запроса — то самое «сырьё». */
  prompt: string;
}

export interface LlmCall<T> {
  value: T;
  meta: CallMeta;
}

/** Расход у SDK описан по-разному для чата и эмбеддингов; сводим к одному. */
function tokensOf(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}): TokenUsage {
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
  };
}

/**
 * Усечение эмбеддинга до объявленной размерности. Делается своими руками:
 * `providerOptions.dimensions` OpenRouter молча игнорирует — 07.09.2026
 * карточка конвейера показала 2560 чисел там, где конфиг обещает 1536.
 * Модель матрёшечная, поэтому первые N координат — законный вектор меньшей
 * размерности, а косинус нормирует длину сам.
 */
export function truncateEmbedding(values: number[]): Float32Array {
  return Float32Array.from(values.slice(0, EMBEDDING_DIMENSIONS));
}

/**
 * Метрики вызова, который не состоялся или сорвался. Запись о сбое нужна в
 * журнале не меньше удачной: иначе пропавший этап выглядит несделанным.
 */
export function failedMeta(model: string): CallMeta {
  return emptyMeta(model);
}

/** Метрики несостоявшегося вызова: пустая пачка эмбеддингов никуда не ходит. */
function emptyMeta(model: string): CallMeta {
  return {
    model,
    attempts: 0,
    durationMs: 0,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    system: '',
    prompt: '',
  };
}

export interface SummarizeInput {
  title: string;
  kind: ReviewKind;
  reviews: Review[];
}

export interface OpenRouterClientOptions {
  apiKey?: string | undefined;
  model?: string;
  embeddingModel?: string;
  letsplayModel?: string;
  /** Таймаут одной попытки, мс. */
  timeoutMs?: number;
  /** Таймаут вызовов по летсплеям: вход там на порядок больше. */
  letsplayTimeoutMs?: number;
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

/**
 * Летсплеям нужен свой, больший потолок: на вход уходит расшифровка целиком —
 * 13–23 тысячи токенов против трёх тысяч у резюме. На общем таймауте прогон
 * падал по времени, хотя запрос был исправен.
 */
const DEFAULT_LETSPLAY_TIMEOUT_MS = 120_000;

export class OpenRouterClient {
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly letsplayModel: string;
  private readonly letsplayTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly provider: ReturnType<typeof createOpenRouter>;

  constructor(opts: OpenRouterClientOptions = {}) {
    const apiKey = opts.apiKey ?? env.OPENROUTER_API_KEY;
    if (!apiKey) throw new MissingApiKeyError();

    this.model = opts.model ?? SUMMARY_MODEL;
    this.embeddingModel = opts.embeddingModel ?? EMBEDDING_MODEL;
    this.letsplayModel = opts.letsplayModel ?? LETSPLAY_MODEL;
    this.letsplayTimeoutMs = opts.letsplayTimeoutMs ?? DEFAULT_LETSPLAY_TIMEOUT_MS;
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
  async summarizeReviews(input: SummarizeInput): Promise<LlmCall<ReviewSummary>> {
    const corpus = input.reviews
      .map((r, i) => {
        const score = r.score === null ? 'без оценки' : `${r.score}/${r.scoreMax}`;
        const text = r.text.slice(0, SUMMARY_LIMITS.maxReviewChars);
        return `[${i + 1}] ${score}: ${text}`;
      })
      .join('\n');

    const prompt = `Отзывы ${KIND_NAME[input.kind]} об игре «${input.title}»:\n\n${corpus}`;
    return this.measured(SYSTEM_PROMPT, prompt, this.model, () => this.generateOnce(prompt));
  }

  /**
   * Обёртка, которая считает то, чего не видно из ответа: сколько было
   * попыток, сколько это заняло и что именно ушло в модель. Без этих чисел
   * карточка конвейера не может показать «процесс работы модели» (§10).
   */
  private async measured<T>(
    system: string,
    prompt: string,
    model: string,
    attempt: () => Promise<{ value: T; usage: TokenUsage }>,
  ): Promise<LlmCall<T>> {
    const startedAt = Date.now();
    const { value, attempts } = await this.withRetries(attempt);
    const { inputTokens, outputTokens } = value.usage;

    return {
      value: value.value,
      meta: {
        model,
        attempts,
        durationMs: Date.now() - startedAt,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        costUsd: estimateCostUsd(model, inputTokens, outputTokens),
        system,
        prompt,
      },
    };
  }

  /**
   * Повтор своими руками, а не через `maxRetries` SDK: у каждой попытки должен
   * быть свой таймаут. Один сигнал на все попытки означает, что первая же
   * зависшая съедает весь бюджет и повторов не происходит — на этом одна игра
   * падала стабильно, хотя вручную считалась за пять секунд.
   */
  private async withRetries<T>(
    attempt: () => Promise<T>,
  ): Promise<{ value: T; attempts: number }> {
    let lastErr: unknown;

    for (let i = 1; i <= this.maxAttempts; i++) {
      try {
        return { value: await attempt(), attempts: i };
      } catch (err) {
        lastErr = err;
        if (i === this.maxAttempts) break;
        await delay(500 * 2 ** (i - 1));
      }
    }

    throw lastErr;
  }

  /**
   * Тот ли это ролик. Расшифровка уходит ЦЕЛИКОМ: 13 тысяч токенов — это 7%
   * контекста и меньше цента, а урезание до выдержек роняло точность (§6).
   */
  async judgeVideoMatch(
    game: GameInfo,
    video: VideoInfo,
    transcript: string,
  ): Promise<LlmCall<VideoMatch>> {
    const prompt = [
      `ИГРА\n${gameBlock(game)}`,
      `РОЛИК\nНазвание: ${video.title}\nКанал: ${video.channel ?? '—'}`,
      `РАСШИФРОВКА РЕЧИ АВТОРА (${transcript.length} знаков)\n${transcript}`,
    ].join('\n\n');

    return this.measured(JUDGE_PROMPT, prompt, this.letsplayModel, async () => {
      const { output, usage } = await generateText({
        model: this.provider.chat(this.letsplayModel),
        output: Output.object({ schema: videoMatchSchema }),
        system: JUDGE_PROMPT,
        prompt,
        providerOptions: { openrouter: { reasoning: { enabled: false } } },
        abortSignal: AbortSignal.timeout(this.letsplayTimeoutMs),
        maxRetries: 0,
      });
      return { value: output, usage: tokensOf(usage) };
    });
  }

  /** Заключение по летсплею: пересказ впечатления автора, не наш обзор. */
  async concludeLetsplay(
    game: GameInfo,
    video: VideoInfo,
    transcript: string,
  ): Promise<LlmCall<LetsplayConclusion>> {
    const prompt = [
      `ИГРА: ${game.title}`,
      `РОЛИК: ${video.title} (канал ${video.channel ?? '—'})`,
      `РАСШИФРОВКА РЕЧИ АВТОРА\n${transcript}`,
    ].join('\n\n');

    return this.measured(CONCLUSION_PROMPT, prompt, this.letsplayModel, async () => {
      const { output, usage } = await generateText({
        model: this.provider.chat(this.letsplayModel),
        output: Output.object({ schema: letsplayConclusionSchema }),
        system: CONCLUSION_PROMPT,
        prompt,
        providerOptions: { openrouter: { reasoning: { enabled: false } } },
        abortSignal: AbortSignal.timeout(this.timeoutMs),
        maxRetries: 0,
      });
      return { value: output, usage: tokensOf(usage) };
    });
  }

  /**
   * Эмбеддинги пачкой. Размерность усечённая: модель матрёшечная, 1536 из
   * родных 2560 (§4). Порядок ответа соответствует порядку входа.
   */
  async embed(texts: string[]): Promise<LlmCall<Float32Array[]>> {
    if (texts.length === 0) {
      return { value: [], meta: emptyMeta(this.embeddingModel) };
    }

    return this.measured(
      '',
      texts.join('\n---\n'),
      this.embeddingModel,
      async () => {
        const { embeddings, usage } = await embedMany({
          model: this.provider.textEmbeddingModel(this.embeddingModel),
          values: texts,
          providerOptions: { openrouter: { dimensions: EMBEDDING_DIMENSIONS } },
          // Тот же порядок, что и у резюме: свой таймаут на каждую попытку.
          abortSignal: AbortSignal.timeout(this.timeoutMs),
          maxRetries: 0,
        });

        if (embeddings.length !== texts.length) {
          throw new Error(
            `OpenRouter вернул ${embeddings.length} эмбеддингов на ${texts.length} текстов`,
          );
        }
        return {
          // Усечение делаем сами. `providerOptions.dimensions` OpenRouter
          // молча игнорирует: 07.09.2026 карточка конвейера показала 2560
          // чисел там, где конфиг обещает 1536. Модель матрёшечная, поэтому
          // первые N координат — законный вектор меньшей размерности, а
          // косинус нормирует длину сам.
          value: embeddings.map(truncateEmbedding),
          // У эмбеддингов расход общий на пачку, выхода нет.
          usage: { inputTokens: usage.tokens, outputTokens: null },
        };
      },
    );
  }

  private async generateOnce(
    prompt: string,
  ): Promise<{ value: ReviewSummary; usage: TokenUsage }> {
    const { output, usage } = await generateText({
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

    return { value: output, usage: tokensOf(usage) };
  }
}
