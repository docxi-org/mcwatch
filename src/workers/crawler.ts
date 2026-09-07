import type { Logger } from 'pino';
import type { GameCard, ListedGame, MetacriticClient } from '../clients/metacritic/index.js';
import { componentLogger } from '../config/logger.js';
import type { Db } from '../db/index.js';
import {
  advance,
  loadOrCreateState,
  planTarget,
  saveState,
  utcDate,
  type CrawlTarget,
} from '../db/repo/crawlState.js';
import {
  markGameFailed,
  replacePlatforms,
  upsertGame,
  type PlatformScores,
} from '../db/repo/games.js';

/**
 * Воркер сбора — `docs/ARCHITECTURE.md` §2. Один заход = один список
 * (New Releases либо очередная страница browse) и последовательный обход его
 * игр. Ошибка одной игры помечает её `failed` и обход продолжается.
 */

export interface CrawlDeps {
  db: Db;
  client: MetacriticClient;
  now?: () => Date;
  log?: Logger;
}

export interface CrawlFailure {
  slug: string;
  error: string;
}

export interface CrawlResult {
  date: string;
  target: CrawlTarget;
  /** Сколько игр отдал список. */
  listed: number;
  /** Сколько элементов списка не прошли схему и отброшены парсером. */
  skippedInList: number;
  /** Сколько отсеяно как уже обработанные сегодня (ТЗ: «сегодня не обрабатывал»). */
  alreadyProcessedToday: number;
  saved: number;
  failed: number;
  failures: CrawlFailure[];
}

/**
 * Оценки по платформам. Metascore есть на карточке, а userscore приходится
 * запрашивать по каждой платформе отдельно: без сегмента пути бэкенд отдаёт
 * ведущую платформу, а query-параметр игнорирует (§6).
 */
async function collectPlatformScores(
  client: MetacriticClient,
  card: GameCard,
  log: Logger,
): Promise<PlatformScores[]> {
  const out: PlatformScores[] = [];

  for (const p of card.platforms) {
    let userscore: number | null = null;
    let userCount: number | null = null;

    if (p.slug) {
      try {
        const stats = await client.getScoreStats('user', card.slug, p.slug);
        userscore = stats.score;
        userCount = stats.reviewCount;
      } catch (err) {
        // Оценка пользователей — не повод потерять всю платформу с metascore.
        log.warn(
          { err, slug: card.slug, platform: p.slug },
          'не удалось получить userscore платформы',
        );
      }
    }

    out.push({
      name: p.name,
      slug: p.slug,
      metascore: p.metascore,
      criticCount: p.criticCount,
      userscore,
      userCount,
    });
  }

  return out;
}

async function fetchList(
  client: MetacriticClient,
  target: CrawlTarget,
): Promise<{ games: ListedGame[]; skipped: number }> {
  const { games, skipped } =
    target.phase === 'landing'
      ? await client.listNewReleases()
      : await client.listBrowsePage(target.page);
  return { games, skipped };
}

/** Один заход сбора. Возвращает сводку — её же печатает CLI и покажет G5. */
export async function runCrawlOnce(deps: CrawlDeps): Promise<CrawlResult> {
  const { db, client } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? componentLogger('crawler');

  const date = utcDate(now());
  const state = loadOrCreateState(db, date);
  const target = planTarget(state);

  log.info({ date, target }, 'заход сбора начат');

  const { games: listed, skipped } = await fetchList(client, target);

  const processedToday = new Set(state.processedSlugs);
  const todo = listed.filter((g) => !processedToday.has(g.slug));

  const result: CrawlResult = {
    date,
    target,
    listed: listed.length,
    skippedInList: skipped,
    alreadyProcessedToday: listed.length - todo.length,
    saved: 0,
    failed: 0,
    failures: [],
  };

  const touched: string[] = [];

  for (const item of todo) {
    try {
      const card = await client.getGameCard(item.slug);
      const platforms = await collectPlatformScores(client, card, log);

      upsertGame(db, card, now());
      replacePlatforms(db, card.slug, platforms);

      result.saved++;
      log.debug({ slug: card.slug, platforms: platforms.length }, 'игра сохранена');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markGameFailed(db, item.slug, item.title, message, now());
      result.failed++;
      result.failures.push({ slug: item.slug, error: message });
      log.warn({ err, slug: item.slug }, 'игра не собрана, обход продолжается');
    }
    // Игра считается обработанной сегодня и при неудаче: иначе следующий заход
    // упрётся в неё же вместо того, чтобы двигаться дальше.
    touched.push(item.slug);
  }

  saveState(db, advance(state, touched));

  log.info(
    { date, saved: result.saved, failed: result.failed, listed: result.listed },
    'заход сбора завершён',
  );
  return result;
}
