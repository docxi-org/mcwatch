import type { ReviewKind } from './types.js';

/**
 * Построители URL JSON-бэкенда. Формы и ограничения — `docs/ARCHITECTURE.md` §6,
 * фикстуры в `test/fixtures/metacritic/`. apiKey не нужен и не передаётся.
 */

export const BACKEND_ORIGIN = 'https://backend.metacritic.com';
export const SITE_ORIGIN = 'https://www.metacritic.com';

/** `mcoTypeId` источника: 13 — игра. */
const GAME_TYPE_ID = 13;

/** Размер блока New Releases на `/game/` — 20 игр (ТЗ п.1). */
export const NEW_RELEASES_SIZE = 20;

/** Размер страницы browse — 24 игры (ТЗ п.2). */
export const BROWSE_PAGE_SIZE = 24;

/**
 * Бэкенд отдаёт не больше 10 отзывов критиков за запрос независимо от `limit`
 * (§6): просить больше бесполезно, 93 отзыва — это 10 запросов.
 */
export const CRITIC_PAGE_SIZE = 10;

/**
 * Для пользователей `limit` соблюдается — проверено до 100 (§6). Запрашивать
 * по 10, как у критиков, значило бы тратить втрое больше секунд rate-limit.
 */
export const USER_PAGE_SIZE_MAX = 100;

function backend(path: string, params: Record<string, string | number>): string {
  const url = new URL(path, BACKEND_ORIGIN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Блок New Releases страницы `/game/`. Отличается от browse единственным
 * параметром `metaScoreMin=1` — именно он оставляет игры со скором (§6).
 */
export function newReleasesUrl(limit = NEW_RELEASES_SIZE): string {
  return backend('/finder/metacritic/web', {
    sortBy: '-releaseDate',
    metaScoreMin: 1,
    offset: 0,
    limit,
    mcoTypeId: GAME_TYPE_ID,
  });
}

/** Страница browse, нумерация с 1 (ТЗ п.2). */
export function browsePageUrl(page: number, limit = BROWSE_PAGE_SIZE): string {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(`Номер страницы browse должен быть ≥ 1, получено ${page}`);
  }
  return backend('/finder/metacritic/web', {
    sortBy: '-releaseDate',
    offset: (page - 1) * limit,
    limit,
    mcoTypeId: GAME_TYPE_ID,
  });
}

export function gameCardUrl(slug: string): string {
  return backend(`/games/metacritic/${encodeURIComponent(slug)}/web`, {});
}

/**
 * Сводная оценка. `platform` обязателен для userscore: без сегмента пути
 * бэкенд молча отдаёт ведущую платформу, а query-параметр игнорирует (§6).
 */
export function scoreStatsUrl(
  kind: ReviewKind,
  slug: string,
  platform: string | null = null,
): string {
  const base = `/reviews/metacritic/${kind}/games/${encodeURIComponent(slug)}`;
  const path = platform ? `${base}/platform/${encodeURIComponent(platform)}` : base;
  return backend(`${path}/stats/web`, {});
}

export type Sentiment = 'all' | 'positive' | 'neutral' | 'negative';

/** Список отзывов. `filterBySentiment` даёт выборку по тональности (§4.1). */
export function reviewListUrl(
  kind: ReviewKind,
  slug: string,
  opts: {
    platform?: string | null;
    offset?: number;
    limit?: number;
    sentiment?: Sentiment;
    sort?: 'date' | 'score';
  } = {},
): string {
  const base = `/reviews/metacritic/${kind}/games/${encodeURIComponent(slug)}`;
  const path = opts.platform
    ? `${base}/platform/${encodeURIComponent(opts.platform)}`
    : base;
  return backend(`${path}/web`, {
    offset: opts.offset ?? 0,
    limit: opts.limit ?? CRITIC_PAGE_SIZE,
    filterBySentiment: opts.sentiment ?? 'all',
    sort: opts.sort ?? 'date',
  });
}

/**
 * Обложка: `bucketType` + `bucketPath` на неподписанном пути `/a/img/`.
 * Подписанная форма `/a/img/resize/<hash>/…` из наших данных не собирается (§6).
 */
export function imageUrl(
  bucketType: string | null,
  bucketPath: string | null,
): string | null {
  if (!bucketType || !bucketPath) return null;
  return `${SITE_ORIGIN}/a/img/${bucketType}${bucketPath}`;
}

/** Страница трейлера у jwplayer по идентификатору из карточки. */
export function videoUrlFromJwPlayerId(id: string | null): string | null {
  return id ? `https://cdn.jwplayer.com/players/${id}.html` : null;
}
