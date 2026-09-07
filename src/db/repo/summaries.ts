import { and, eq } from 'drizzle-orm';
import type { ReviewKind } from '../../clients/metacritic/index.js';
import type { ReviewSummary } from '../../clients/openrouter.js';
import type { Db } from '../index.js';
import { summaries } from '../schema.js';

/**
 * Резюме отзывов. Одно на игру и вид отзывов, без разбивки по платформам —
 * решение владельца 07.09.2026 (§4.1): по платформам выборки получаются
 * медианой в 7 отзывов, а расхождение оценок между ними — шум в 1–6 баллов.
 */

export interface StoredSummary {
  gameSlug: string;
  kind: ReviewKind;
  likes: string[];
  dislikes: string[];
  summary: string;
  model: string;
  reviewCountAt: number;
  createdAt: Date;
}

/** Порог роста числа отзывов, после которого резюме пересчитывается (§4.1). */
export const REFRESH_GROWTH_RATIO = 1.2;
/** Абсолютный прирост, после которого резюме пересчитывается. */
export const REFRESH_GROWTH_ABSOLUTE = 10;
/** Возраст, после которого резюме пересчитывается независимо от роста. */
export const REFRESH_MAX_AGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RefreshReason =
  | 'missing'
  | 'grew_by_ratio'
  | 'grew_by_count'
  | 'stale'
  | null;

/**
 * Нужно ли пересчитывать резюме. Чистая функция: всё, что влияет на решение,
 * приходит аргументами, поэтому правило проверяется без сети и без часов.
 *
 * Возраст считается от `created_at` самого резюме, а не от даты обхода: иначе
 * частота пересчёта зависела бы от того, как часто мы ходим.
 *
 * @returns причину пересчёта либо `null`, если резюме актуально
 */
export function refreshReason(
  existing: Pick<StoredSummary, 'reviewCountAt' | 'createdAt'> | null,
  reviewCountNow: number,
  now: Date,
): RefreshReason {
  if (!existing) return 'missing';
  if (reviewCountNow >= existing.reviewCountAt * REFRESH_GROWTH_RATIO) {
    return 'grew_by_ratio';
  }
  if (reviewCountNow >= existing.reviewCountAt + REFRESH_GROWTH_ABSOLUTE) {
    return 'grew_by_count';
  }
  if (now.getTime() - existing.createdAt.getTime() >= REFRESH_MAX_AGE_DAYS * DAY_MS) {
    return 'stale';
  }
  return null;
}

export function getSummary(
  db: Db,
  slug: string,
  kind: ReviewKind,
): StoredSummary | null {
  const row = db
    .select()
    .from(summaries)
    .where(and(eq(summaries.gameSlug, slug), eq(summaries.kind, kind)))
    .get();
  return row ?? null;
}

export function upsertSummary(
  db: Db,
  slug: string,
  kind: ReviewKind,
  result: ReviewSummary,
  model: string,
  reviewCountAt: number,
  now: Date,
): void {
  const row = {
    likes: result.likes,
    dislikes: result.dislikes,
    summary: result.summary,
    model,
    reviewCountAt,
    // Пересчитанное резюме считается свежим: возраст меряется от этой отметки.
    createdAt: now,
  };

  db.insert(summaries)
    .values({ gameSlug: slug, kind, ...row })
    .onConflictDoUpdate({
      target: [summaries.gameSlug, summaries.kind],
      set: row,
    })
    .run();
}
