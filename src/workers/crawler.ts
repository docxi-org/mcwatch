import type { Logger } from 'pino';
import type {
  GameCard,
  ListedGame,
  MetacriticClient,
  Review,
} from '../clients/metacritic/index.js';
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
import { upsertReviews } from '../db/repo/reviews.js';
import { nullReporter, type Reporter } from './monitor.js';

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
  /** Куда докладывать о ходе работы. По умолчанию — никуда. */
  reporter?: Reporter;
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
  /** Сколько строк отзывов записано за заход, по видам. */
  reviewsWritten: { critic: number; user: number };
  failures: CrawlFailure[];
}

/**
 * Выборка отзывов пользователей берётся по тональностям, а не первыми N
 * подряд (§4.1). Источник умеет фильтровать сам (§6), поэтому выборка
 * получается сбалансированной и каждый отзыв приходит с достоверной меткой.
 */
const USER_SENTIMENTS = ['positive', 'neutral', 'negative'] as const;

/** Имя воркера в мониторинге. */
export const WORKER = 'crawler';

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

/**
 * Отзывы игры по всем платформам, где они есть. Сколько их на платформе, уже
 * известно из карточки и сводки оценок — где ноль, запроса не делаем.
 * Платформы обходятся начиная с ведущей: на ней отзывов обычно больше всего.
 */
async function collectReviews(
  client: MetacriticClient,
  slug: string,
  kind: 'critic' | 'user',
  platforms: PlatformScores[],
  log: Logger,
): Promise<Review[]> {
  const ordered = [...platforms].sort(
    (a, b) => (countOf(b, kind) ?? 0) - (countOf(a, kind) ?? 0),
  );
  const collected: Review[] = [];
  const seen = new Set<string>();

  for (const p of ordered) {
    if (!p.slug || !countOf(p, kind)) continue;

    try {
      const batch =
        kind === 'user'
          ? await collectUserBySentiment(client, slug, p.slug)
          : await client.listReviews('critic', slug, { platform: p.slug });

      for (const r of batch) {
        // Один и тот же отзыв критика попадается на разных платформах.
        if (seen.has(r.externalId)) continue;
        seen.add(r.externalId);
        collected.push(r);
      }
    } catch (err) {
      // Отзывы одной платформы — не повод потерять игру и остальные платформы.
      log.warn({ err, slug, platform: p.slug, kind }, 'отзывы платформы не собраны');
    }
  }

  return collected;
}

function countOf(p: PlatformScores, kind: 'critic' | 'user'): number | null {
  return kind === 'critic' ? p.criticCount : p.userCount;
}

/** Поровну из каждой тональности — так резюме не перекосит в хвалу (§4.1). */
async function collectUserBySentiment(
  client: MetacriticClient,
  slug: string,
  platform: string,
): Promise<Review[]> {
  const perBucket = Math.ceil(30 / USER_SENTIMENTS.length);
  const out: Review[] = [];

  for (const sentiment of USER_SENTIMENTS) {
    out.push(
      ...(await client.listReviews('user', slug, {
        platform,
        sentiment,
        max: perBucket,
      })),
    );
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
  const report = deps.reporter ?? nullReporter;

  report.started(WORKER);
  const date = utcDate(now());
  const state = loadOrCreateState(db, date);
  const target = planTarget(state);

  log.info({ date, target }, 'заход сбора начат');
  report.log(WORKER, 'info', 'заход начат', { date, target });

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
    reviewsWritten: { critic: 0, user: 0 },
    failures: [],
  };

  const touched: string[] = [];

  for (const item of todo) {
    report.checked(WORKER);
    report.item(WORKER, item.title);
    try {
      const card = await client.getGameCard(item.slug);
      const platforms = await collectPlatformScores(client, card, log);

      upsertGame(db, card, now());
      replacePlatforms(db, card.slug, platforms);

      for (const kind of ['critic', 'user'] as const) {
        const list = await collectReviews(client, card.slug, kind, platforms, log);
        result.reviewsWritten[kind] += upsertReviews(db, card.slug, list);
      }

      result.saved++;
      report.processed(WORKER);
      log.debug({ slug: card.slug, platforms: platforms.length }, 'игра сохранена');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markGameFailed(db, item.slug, item.title, message, now());
      result.failed++;
      result.failures.push({ slug: item.slug, error: message });
      report.failed(WORKER);
      report.log(WORKER, 'warn', `игра не собрана: ${item.slug}`, { error: message });
      log.warn({ err, slug: item.slug }, 'игра не собрана, обход продолжается');
    }
    // Игра считается обработанной сегодня и при неудаче: иначе следующий заход
    // упрётся в неё же вместо того, чтобы двигаться дальше.
    touched.push(item.slug);
  }

  saveState(db, advance(state, touched));

  log.info(
    {
      date,
      saved: result.saved,
      failed: result.failed,
      listed: result.listed,
      reviews: result.reviewsWritten,
    },
    'заход сбора завершён',
  );
  // Итог читается строкой, без разворачивания `data`: молчаливый ноль
  // неотличим от поломки (решение владельца 07.09.2026).
  report.log(
    WORKER,
    'info',
    `заход завершён · в списке: ${result.listed} · сохранено: ${result.saved} · ` +
      `уже обрабатывали сегодня: ${result.alreadyProcessedToday} · ` +
      `отзывов: ${result.reviewsWritten.critic + result.reviewsWritten.user}` +
      (result.failed > 0 ? ` · сбоев: ${result.failed}` : ''),
    {
      listed: result.listed,
      saved: result.saved,
      alreadyProcessedToday: result.alreadyProcessedToday,
      failed: result.failed,
      reviews: result.reviewsWritten,
    },
  );
  report.finished(WORKER);
  return result;
}
