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
  listGames,
  listPlatforms,
  MAX_PAGE_SIZE,
} from '../db/repo/catalog.js';
import { loadSimilarityPool } from '../db/repo/embeddings.js';
import { findSimilar } from '../workers/similarity.js';
import type { GameCardDto, GameListDto, SimilarGameDto } from './types.js';

/**
 * Каталог: список, карточка, справочник платформ. Требования — `docs/TASK.md`,
 * черновик маршрутов — `docs/ARCHITECTURE.md` §5.
 */

const listQuerySchema = z.object({
  platform: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
  sort: z.enum(['metascore', 'userscore', 'date', 'title']).default('date'),
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

    const { platform, q, sort, page, pageSize } = parsed.data;
    const result = listGames(db, {
      platform: platform ?? null,
      q: q ?? null,
      sort,
      page,
      pageSize,
    });

    return c.json(result satisfies GameListDto);
  });

  app.get('/platforms', (c) => c.json(listPlatforms(db)));

  app.get('/games/:slug', (c) => {
    const slug = c.req.param('slug');
    const game = getGame(db, slug);
    if (!game) return c.json({ error: 'not_found' }, 404);

    const card: GameCardDto = {
      slug: game.slug,
      title: game.title,
      coverUrl: game.coverUrl,
      videoUrl: game.videoUrl,
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
    };

    return c.json(card);
  });

  return app;
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
