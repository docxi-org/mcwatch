import { eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../index.js';
import { gamePlatforms, games } from '../schema.js';
import { EMBEDDING_DIMENSIONS } from '../../config/models.js';
import type { SimilarityCandidate } from '../../workers/similarity.js';

/**
 * Хранение эмбеддингов и чтение материала для похожих игр (§4.2).
 * Вектор лежит в BLOB как последовательность float32.
 */

export function encodeEmbedding(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function decodeEmbedding(b: Buffer): Float32Array {
  // Копия, а не вид на буфер драйвера: он переиспользует память между строками.
  const copy = Buffer.from(b);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export interface PendingEmbedding {
  slug: string;
  title: string;
  genres: string[] | null;
  developer: string | null;
  description: string | null;
  descriptionHash: string | null;
}

/**
 * Игры, которым нужен эмбеддинг. Отдельного «хеша на момент расчёта» нет и не
 * нужно: сборщик обнуляет `embedding` сам, как только `description_hash`
 * изменился (см. `repo/games.ts`). Значит «нужен» = «его нет».
 */
/** Сколько байт занимает вектор объявленной размерности: 4 байта на число. */
const EXPECTED_BYTES = EMBEDDING_DIMENSIONS * 4;

export function findGamesNeedingEmbedding(db: Db): PendingEmbedding[] {
  return db
    .select({
      slug: games.slug,
      title: games.title,
      genres: games.genres,
      developer: games.developer,
      description: games.description,
      descriptionHash: games.descriptionHash,
    })
    .from(games)
    // Вектор чужой размерности равносилен его отсутствию: косинус между
    // векторами разной длины возвращает 0, и такие игры молча выпадают из
    // похожих. Один раз это уже случилось — 07.09.2026 усечение до 1536
    // разрезало базу надвое, и 21 игра осталась без единой похожей.
    .where(or(isNull(games.embedding), ne(sql`length(${games.embedding})`, EXPECTED_BYTES)))
    .all();
}

export function saveEmbedding(db: Db, slug: string, vector: Float32Array): void {
  db.update(games)
    .set({ embedding: encodeEmbedding(vector) })
    .where(eq(games.slug, slug))
    .run();
}

/**
 * Материал для расчёта похожих: все игры с эмбеддингом, вместе с жанрами и
 * платформами. Читается целиком в память — при базе больше 5k игр
 * пересмотреть (§4.2).
 */
export function loadSimilarityPool(db: Db): SimilarityCandidate[] {
  const rows = db
    .select({
      slug: games.slug,
      embedding: games.embedding,
      genres: games.genres,
      developer: games.developer,
    })
    .from(games)
    .where(isNotNull(games.embedding))
    .all();

  const platforms = new Map<string, string[]>();
  for (const p of db
    .select({ slug: gamePlatforms.gameSlug, platform: gamePlatforms.platform })
    .from(gamePlatforms)
    .all()) {
    const list = platforms.get(p.slug);
    if (list) list.push(p.platform);
    else platforms.set(p.slug, [p.platform]);
  }

  return rows.map((r) => ({
    slug: r.slug,
    embedding: r.embedding ? decodeEmbedding(r.embedding) : null,
    genres: r.genres ?? [],
    platforms: platforms.get(r.slug) ?? [],
    developer: r.developer,
  }));
}
