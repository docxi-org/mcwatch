import { and, count, eq } from 'drizzle-orm';
import type { Review, ReviewKind } from '../../clients/metacritic/index.js';
import type { Db } from '../index.js';
import { reviews } from '../schema.js';

/**
 * Хранение отзывов. Дедупликация — по `UNIQUE(game_slug, kind, external_id)`:
 * повторный обход видит те же отзывы и не должен их удваивать.
 */

/**
 * Вставляет отзывы, обновляя уже известные. Обновление, а не пропуск: у
 * Metacritic пользователь может отредактировать свой отзыв, а тональность мы
 * узнаём из запроса и при следующем обходе она может уточниться.
 *
 * @returns сколько строк реально записано
 */
export function upsertReviews(db: Db, slug: string, list: Review[]): number {
  if (list.length === 0) return 0;

  return db.transaction((tx) => {
    let written = 0;
    for (const r of list) {
      const changed = tx
        .insert(reviews)
        .values({
          gameSlug: slug,
          kind: r.kind,
          externalId: r.externalId,
          score: r.score,
          scoreMax: r.scoreMax,
          author: r.author,
          platform: r.platform,
          date: r.date,
          text: r.text,
          sentiment: r.sentiment,
          url: r.url,
        })
        .onConflictDoUpdate({
          target: [reviews.gameSlug, reviews.kind, reviews.externalId],
          set: {
            score: r.score,
            text: r.text,
            sentiment: r.sentiment,
            date: r.date,
            platform: r.platform,
          },
        })
        .run();
      written += changed.changes;
    }
    return written;
  });
}

/**
 * Сколько отзывов вида сохранено. Это, а не `reviewCount` источника, — вход
 * правила обновления резюме: `reviewCount` считает оценки, а не тексты (§6).
 */
export function countReviews(db: Db, slug: string, kind: ReviewKind): number {
  const row = db
    .select({ n: count() })
    .from(reviews)
    .where(and(eq(reviews.gameSlug, slug), eq(reviews.kind, kind)))
    .get();
  return row?.n ?? 0;
}
