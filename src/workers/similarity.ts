/**
 * Похожие игры — `docs/ARCHITECTURE.md` §4.2. Считается детерминированным
 * кодом, не моделью: модель делает ровно три вещи, и это не одна из них
 * (CLAUDE.md, «Где модель, где код»).
 */

/** Веса из §4.2. В сумме основные дают 1, надбавка за разработчика — сверху. */
export const WEIGHTS = {
  embedding: 0.6,
  genres: 0.3,
  platforms: 0.1,
  sameDeveloper: 0.05,
} as const;

/** Ниже этого похожей игра не считается: лучше пустой блок, чем случайный. */
export const SIMILARITY_THRESHOLD = 0.45;

/** Сколько похожих показывается в карточке. */
export const SIMILAR_LIMIT = 5;

export interface SimilarityCandidate {
  slug: string;
  embedding: Float32Array | null;
  genres: string[];
  platforms: string[];
  developer: string | null;
}

export interface SimilarGame {
  slug: string;
  score: number;
}

/** Косинус между векторами равной длины; несравнимые пары дают 0. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }

  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Жаккар по множествам. Две пустые пары считаются несхожими (0), а не
 * тождественными (1): «ничего не знаем об обеих» — не признак сходства.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a.map((x) => x.toLowerCase()));
  const setB = new Set(b.map((x) => x.toLowerCase()));
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const x of setA) if (setB.has(x)) shared++;
  return shared / (setA.size + setB.size - shared);
}

/** Оценка сходства пары по формуле §4.2. */
export function similarityScore(
  a: SimilarityCandidate,
  b: SimilarityCandidate,
): number {
  const byText =
    a.embedding && b.embedding ? cosine(a.embedding, b.embedding) : 0;

  const score =
    WEIGHTS.embedding * byText +
    WEIGHTS.genres * jaccard(a.genres, b.genres) +
    WEIGHTS.platforms * jaccard(a.platforms, b.platforms) +
    (a.developer && b.developer && a.developer === b.developer
      ? WEIGHTS.sameDeveloper
      : 0);

  return score;
}

/**
 * Топ похожих на `target` среди `pool`. Сама игра из выдачи исключается.
 * Порядок при равных оценках задаётся slug — иначе выдача плавала бы между
 * запросами при одинаковых баллах.
 */
export function findSimilar(
  target: SimilarityCandidate,
  pool: readonly SimilarityCandidate[],
  limit = SIMILAR_LIMIT,
  threshold = SIMILARITY_THRESHOLD,
): SimilarGame[] {
  const scored: SimilarGame[] = [];

  for (const other of pool) {
    if (other.slug === target.slug) continue;
    const score = similarityScore(target, other);
    if (score >= threshold) scored.push({ slug: other.slug, score });
  }

  scored.sort((x, y) => y.score - x.score || x.slug.localeCompare(y.slug));
  return scored.slice(0, limit);
}
