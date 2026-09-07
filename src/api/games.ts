import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  DEFAULT_PAGE_SIZE,
  getGame,
  getGameBriefs,
  getPlatformScores,
  getReviewCounts,
  getSummaries,
  listFacets,
  listGames,
  listPlatforms,
  MAX_PAGE_SIZE,
} from '../db/repo/catalog.js';
import { gamePageUrl, videoPosterUrl } from '../clients/metacritic/endpoints.js';
import { loadSimilarityPool } from '../db/repo/embeddings.js';
import { getLetsplay } from '../db/repo/letsplays.js';
import { findSimilar } from '../workers/similarity.js';
import type {
  GameCardDto,
  GameListDto,
  LetsplayDto,
  SimilarGameDto,
} from './types.js';

/**
 * Каталог: список, карточка, справочник платформ. Требования — `docs/TASK.md`,
 * черновик маршрутов — `docs/ARCHITECTURE.md` §5.
 */

/** `?letsplay=1` — включён; отсутствие параметра — фильтр не применён. */
const flag = z
  .enum(['1', 'true'])
  .optional()
  .transform((v) => v !== undefined);

const listQuerySchema = z.object({
  platform: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
  sort: z.enum(['metascore', 'userscore', 'date', 'title']).default('date'),
  letsplay: flag,
  trailer: flag,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export function createCatalogRoutes(db: Db): Hono {
  const app = new Hono();

  app.get('/games', (c) => {
    const parsed = listQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: 'bad_request',
          details: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
        400,
      );
    }

    const { platform, q, sort, letsplay, trailer, page, pageSize } = parsed.data;
    const result = listGames(db, {
      platform: platform ?? null,
      q: q ?? null,
      sort,
      withLetsplay: letsplay,
      withTrailer: trailer,
      page,
      pageSize,
    });

    return c.json(result satisfies GameListDto);
  });

  app.get('/platforms', (c) => c.json(listPlatforms(db)));

  /** Числа для подписей на чипах дополнительных фильтров. */
  app.get('/facets', (c) => c.json(listFacets(db)));

  app.get('/games/:slug', (c) => {
    const slug = c.req.param('slug');
    const game = getGame(db, slug);
    if (!game) return c.json({ error: 'not_found' }, 404);

    const card: GameCardDto = {
      slug: game.slug,
      title: game.title,
      coverUrl: game.coverUrl,
      metacriticUrl: gamePageUrl(game.slug),
      videoUrl: game.videoUrl,
      videoPosterUrl: videoPosterUrl(game.videoUrl),
      developer: game.developer,
      publisher: game.publisher,
      description: game.description,
      genres: game.genres ?? [],
      releaseDate: game.releaseDate,
      esrb: game.esrb,
      status: game.status,
      platforms: getPlatformScores(db, slug),
      summaries: getSummaries(db, slug),
      reviewCounts: getReviewCounts(db, slug),
      similar: similarFor(db, slug),
      letsplay: letsplayFor(db, slug),
    };

    return c.json(card);
  });

  return app;
}

/**
 * Заключение по летсплею. Хранится строкой JSON, потому что структура —
 * ответ модели; наружу отдаётся разобранной.
 */
function letsplayFor(db: Db, slug: string): LetsplayDto | null {
  const row = getLetsplay(db, slug);
  if (!row) return null;

  let parsed: { conclusion?: string; highlights?: string[]; vibe?: string } = {};
  if (row.conclusion) {
    try {
      parsed = JSON.parse(row.conclusion) as typeof parsed;
    } catch {
      // Битую запись показываем как отсутствие заключения, а не роняем карточку.
      parsed = {};
    }
  }

  return {
    url: row.videoId ? `https://www.youtube.com/watch?v=${row.videoId}` : null,
    title: row.title,
    channel: row.channel,
    views: row.views,
    durationS: row.durationS,
    conclusion: parsed.conclusion ?? null,
    highlights: parsed.highlights ?? [],
    vibe: (parsed.vibe as LetsplayDto['vibe']) ?? null,
    status: row.status,
  };
}

/**
 * Похожие считаются на лету по всей базе (§4.2): при 44 играх это микросекунды,
 * а хранить их значило бы пересчитывать при каждой новой игре.
 */
function similarFor(db: Db, slug: string): SimilarGameDto[] {
  const pool = loadSimilarityPool(db);
  const target = pool.find((p) => p.slug === slug);
  if (!target) return [];

  const found = findSimilar(target, pool);
  const briefs = getGameBriefs(
    db,
    found.map((f) => f.slug),
  );

  return found.flatMap((f) => {
    const brief = briefs.get(f.slug);
    return brief
      ? [
          {
            slug: f.slug,
            title: brief.title,
            coverUrl: brief.coverUrl,
            bestMetascore: brief.bestMetascore,
            score: Number(f.score.toFixed(3)),
          },
        ]
      : [];
  });
}
