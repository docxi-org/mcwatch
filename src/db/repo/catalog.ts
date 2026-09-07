import { and, asc, count, desc, eq, like, max, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../index.js';
import { gamePlatforms, games, reviews, summaries } from '../schema.js';
import type {
  GameListItemDto,
  PlatformDto,
  PlatformScoreDto,
  SortKey,
  SummaryDto,
} from '../../api/types.js';

/**
 * Чтение каталога для API. Запросы держатся здесь, а не в маршрутах: слой
 * HTTP занимается разбором параметров и формой ответа, не SQL.
 */

export interface ListQuery {
  platform?: string | null;
  q?: string | null;
  sort?: SortKey;
  page?: number;
  pageSize?: number;
}

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;

/**
 * Рейтинг игры для сортировки — максимум по платформам, не среднее: разные
 * платформы оценивают разные наборы изданий, усреднять их некорректно.
 */
const bestMetascore = max(gamePlatforms.metascore);
const bestUserscore = max(gamePlatforms.userscore);

function whereFor(query: ListQuery): SQL | undefined {
  const parts: SQL[] = [];

  if (query.q) {
    // SQLite без ICU регистронезависим только для латиницы; названия у
    // Metacritic латинские, этого достаточно.
    parts.push(like(sql`lower(${games.title})`, `%${query.q.toLowerCase()}%`));
  }

  if (query.platform) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM ${gamePlatforms} gp
                  WHERE gp.game_slug = ${games.slug} AND gp.platform = ${query.platform})`,
    );
  }

  return parts.length === 0 ? undefined : and(...parts);
}

function orderFor(sort: SortKey): SQL[] {
  switch (sort) {
    case 'metascore':
      // NULL в конец: игра без оценки не должна возглавлять список по рейтингу.
      return [sql`${bestMetascore} IS NULL`, desc(bestMetascore), asc(games.slug)];
    case 'userscore':
      return [sql`${bestUserscore} IS NULL`, desc(bestUserscore), asc(games.slug)];
    case 'title':
      return [asc(games.title), asc(games.slug)];
    case 'date':
      return [sql`${games.releaseDate} IS NULL`, desc(games.releaseDate), asc(games.slug)];
  }
}

export function listGames(db: Db, query: ListQuery): {
  items: GameListItemDto[];
  total: number;
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
  const where = whereFor(query);

  const totalRow = db
    .select({ n: count() })
    .from(games)
    .where(where)
    .get();

  const rows = db
    .select({
      slug: games.slug,
      title: games.title,
      coverUrl: games.coverUrl,
      releaseDate: games.releaseDate,
      developer: games.developer,
      genres: games.genres,
      status: games.status,
      bestMetascore,
      bestUserscore,
    })
    .from(games)
    .leftJoin(gamePlatforms, eq(gamePlatforms.gameSlug, games.slug))
    .where(where)
    .groupBy(games.slug)
    .orderBy(...orderFor(query.sort ?? 'date'))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  const platforms = platformsBySlug(
    db,
    rows.map((r) => r.slug),
  );

  return {
    items: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      coverUrl: r.coverUrl,
      releaseDate: r.releaseDate,
      developer: r.developer,
      genres: r.genres ?? [],
      platforms: platforms.get(r.slug) ?? [],
      bestMetascore: r.bestMetascore,
      bestUserscore: r.bestUserscore,
      status: r.status,
    })),
    total: totalRow?.n ?? 0,
    page,
    pageSize,
  };
}

function platformsBySlug(db: Db, slugs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (slugs.length === 0) return out;

  for (const row of db
    .select({ slug: gamePlatforms.gameSlug, platform: gamePlatforms.platform })
    .from(gamePlatforms)
    .where(sql`${gamePlatforms.gameSlug} IN ${slugs}`)
    .orderBy(asc(gamePlatforms.platform))
    .all()) {
    const list = out.get(row.slug);
    if (list) list.push(row.platform);
    else out.set(row.slug, [row.platform]);
  }
  return out;
}

export interface GameRow {
  slug: string;
  title: string;
  coverUrl: string | null;
  videoUrl: string | null;
  developer: string | null;
  publisher: string | null;
  description: string | null;
  genres: string[] | null;
  releaseDate: string | null;
  esrb: string | null;
  status: 'ok' | 'failed';
}

export function getGame(db: Db, slug: string): GameRow | null {
  return (
    db
      .select({
        slug: games.slug,
        title: games.title,
        coverUrl: games.coverUrl,
        videoUrl: games.videoUrl,
        developer: games.developer,
        publisher: games.publisher,
        description: games.description,
        genres: games.genres,
        releaseDate: games.releaseDate,
        esrb: games.esrb,
        status: games.status,
      })
      .from(games)
      .where(eq(games.slug, slug))
      .get() ?? null
  );
}

export function getPlatformScores(db: Db, slug: string): PlatformScoreDto[] {
  return db
    .select({
      platform: gamePlatforms.platform,
      metascore: gamePlatforms.metascore,
      userscore: gamePlatforms.userscore,
      criticCount: gamePlatforms.criticCount,
      userCount: gamePlatforms.userCount,
    })
    .from(gamePlatforms)
    .where(eq(gamePlatforms.gameSlug, slug))
    .orderBy(asc(gamePlatforms.platform))
    .all();
}

export function getSummaries(
  db: Db,
  slug: string,
): { critic: SummaryDto | null; user: SummaryDto | null } {
  const out: { critic: SummaryDto | null; user: SummaryDto | null } = {
    critic: null,
    user: null,
  };

  for (const row of db
    .select()
    .from(summaries)
    .where(eq(summaries.gameSlug, slug))
    .all()) {
    out[row.kind] = {
      likes: row.likes,
      dislikes: row.dislikes,
      summary: row.summary,
      reviewCount: row.reviewCountAt,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    };
  }

  return out;
}

export function getReviewCounts(
  db: Db,
  slug: string,
): { critic: number; user: number } {
  const out = { critic: 0, user: 0 };
  for (const row of db
    .select({ kind: reviews.kind, n: count() })
    .from(reviews)
    .where(eq(reviews.gameSlug, slug))
    .groupBy(reviews.kind)
    .all()) {
    out[row.kind] = row.n;
  }
  return out;
}

/** Справочник платформ для фильтра: только те, что реально есть в базе. */
export function listPlatforms(db: Db): PlatformDto[] {
  return db
    .select({ platform: gamePlatforms.platform, gameCount: count() })
    .from(gamePlatforms)
    .groupBy(gamePlatforms.platform)
    .orderBy(asc(gamePlatforms.platform))
    .all();
}

/** Названия и обложки для блока похожих — одним запросом, а не по одной. */
export function getGameBriefs(
  db: Db,
  slugs: string[],
): Map<string, { title: string; coverUrl: string | null; bestMetascore: number | null }> {
  const out = new Map<
    string,
    { title: string; coverUrl: string | null; bestMetascore: number | null }
  >();
  if (slugs.length === 0) return out;

  for (const r of db
    .select({
      slug: games.slug,
      title: games.title,
      coverUrl: games.coverUrl,
      bestMetascore,
    })
    .from(games)
    .leftJoin(gamePlatforms, eq(gamePlatforms.gameSlug, games.slug))
    .where(sql`${games.slug} IN ${slugs}`)
    .groupBy(games.slug)
    .all()) {
    out.set(r.slug, {
      title: r.title,
      coverUrl: r.coverUrl,
      bestMetascore: r.bestMetascore,
    });
  }
  return out;
}
