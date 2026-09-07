/**
 * Модели — константы здесь, не в коде вызовов (CLAUDE.md, «Зафиксированные
 * решения»). Выбраны владельцем 07.09.2026 по живой проверке; основания и
 * отвергнутые альтернативы — `docs/ARCHITECTURE.md` §4 и §7.
 */

/** Резюме отзывов. Рассуждения не нужны и явно выключаются при вызове. */
export const SUMMARY_MODEL = 'z-ai/glm-4.7-flash';

/** Эмбеддинги для похожих игр (§4.2). Модель матрёшечная — размерность усекаема. */
export const EMBEDDING_MODEL = 'qwen/qwen3-embedding-4b';

/** Размерность эмбеддинга: родная 2560, берём усечённую. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Транскрипция летсплеев (§4.3). Пока не используется: Whisper отложен. */
export const TRANSCRIBE_MODEL = 'qwen/qwen3-asr-1.7b';

/**
 * Судья соответствия ролика игре и автор заключения по летсплею (§4.3).
 * Та же модель, что и для резюме: задача того же класса.
 */
export const LETSPLAY_MODEL = SUMMARY_MODEL;

export const LETSPLAY_LIMITS = {
  /** Сколько кандидатов проверяется, прежде чем сдаться. */
  maxCandidates: 5,
  maxConclusionChars: 800,
  maxPoints: 4,
  maxPointChars: 120,
} as const;

/**
 * Ограничения на выход резюме. Без явного предела длины модели утрамбовывают
 * лишнее в последний пункт — замечено на сравнительном прогоне.
 */
export const SUMMARY_LIMITS = {
  maxPoints: 5,
  maxPointChars: 120,
  maxSummaryChars: 600,
  /** До скольких знаков режется отзыв на входе (§4.1). */
  maxReviewChars: 600,
} as const;

/**
 * Прайс OpenRouter на 07.09.2026, доллары за миллион токенов. Нужен только
 * для оценки стоимости в карточке конвейера: фактическую цену провайдер
 * отдаёт отдельным запросом, и гонять его ради копеек на каждый вызов
 * незачем. Поэтому в интерфейсе это подписано оценкой, а не фактом.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'z-ai/glm-4.7-flash': { input: 0.05, output: 0.4 },
  'qwen/qwen3-embedding-4b': { input: 0.01, output: 0 },
  'qwen/qwen3-asr-1.7b': { input: 0.02, output: 0.02 },
};

/** Оценка стоимости вызова. `null` — модели нет в прайсе, врать не станем. */
export function estimateCostUsd(
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  const price = MODEL_PRICES[model];
  if (!price || promptTokens === null) return null;
  const out = completionTokens ?? 0;
  return (promptTokens * price.input + out * price.output) / 1_000_000;
}
