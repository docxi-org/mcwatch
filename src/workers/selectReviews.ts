import type { Review, ReviewKind } from '../clients/metacritic/index.js';

/**
 * Отбор отзывов на вход модели — `docs/ARCHITECTURE.md` §4.1. Ограничение
 * касается именно входа: в базе отзывов может лежать больше, и это хорошо —
 * они нужны интерфейсу и счётчикам. Модели же уходит выборка.
 */

/** Сколько отзывов вида уходит модели (§4.1). */
export const SUMMARY_INPUT_LIMIT: Record<ReviewKind, number> = {
  critic: 40,
  user: 30,
};

const BUCKETS = ['positive', 'mixed', 'negative'] as const;

/**
 * Выборка для резюме. У пользователей — поровну из каждой тональности, а не
 * первые N: иначе резюме перекосит в сторону преобладающей группы, а её
 * обычно составляют хвалебные отзывы. У критиков тональности нет (источник её
 * не отдаёт, §6), поэтому берутся первые N.
 */
export function selectForSummary(reviews: Review[], kind: ReviewKind): Review[] {
  const limit = SUMMARY_INPUT_LIMIT[kind];
  if (reviews.length <= limit) return reviews;
  if (kind === 'critic') return reviews.slice(0, limit);

  const byBucket = new Map<string, Review[]>();
  for (const b of BUCKETS) byBucket.set(b, []);
  const unlabelled: Review[] = [];

  for (const r of reviews) {
    const bucket = r.sentiment === null ? null : byBucket.get(r.sentiment);
    if (bucket) bucket.push(r);
    else unlabelled.push(r);
  }

  // Раздаём по кругу: пока в корзине есть отзывы, каждая отдаёт по одному.
  // Так малочисленная тональность не пропадает, а место, которое она не
  // заняла, достаётся остальным.
  const out: Review[] = [];
  const queues = [...BUCKETS.map((b) => byBucket.get(b) ?? []), unlabelled];
  let index = 0;

  while (out.length < limit && queues.some((q) => q.length > index)) {
    for (const q of queues) {
      if (out.length >= limit) break;
      const item = q[index];
      if (item) out.push(item);
    }
    index++;
  }

  return out;
}
