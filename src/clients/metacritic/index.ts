import { env } from '../../config/env.js';
import { SERVICE_NAME } from '../../config/service.js';
import { HttpClient } from '../http.js';
import {
  browsePageUrl,
  CRITIC_PAGE_SIZE,
  gameCardUrl,
  newReleasesUrl,
  reviewListUrl,
  scoreStatsUrl,
  USER_PAGE_SIZE_MAX,
  type Sentiment,
} from './endpoints.js';
import {
  parseGameCard,
  parseGameList,
  parseReviews,
  parseScoreStats,
  type ParsedList,
} from './parse.js';
import type { GameCard, Review, ReviewKind, ScoreStats } from './types.js';

export * from './types.js';
export { BROWSE_PAGE_SIZE, NEW_RELEASES_SIZE } from './endpoints.js';

/** Metacritic: ≤1 запрос/с, UA с названием проекта и контактом (CLAUDE.md). */
const MIN_INTERVAL_MS = 1000;

export function metacriticUserAgent(contact = env.CONTACT_EMAIL): string {
  return `${SERVICE_NAME}/0.1 (+https://github.com/${SERVICE_NAME}; ${contact})`;
}

export interface MetacriticClientOptions {
  http?: HttpClient;
  /** Верхняя граница отзывов одного вида за обход — защита от гигантов. */
  maxReviews?: number;
}

/**
 * Единственная дверь к Metacritic. Формы ответов и ограничения источника —
 * `docs/ARCHITECTURE.md` §6.
 */
export class MetacriticClient {
  private readonly http: HttpClient;
  private readonly maxReviews: number;

  constructor(opts: MetacriticClientOptions = {}) {
    this.http =
      opts.http ??
      new HttpClient({
        userAgent: metacriticUserAgent(),
        minIntervalMs: MIN_INTERVAL_MS,
      });
    this.maxReviews = opts.maxReviews ?? 40;
  }

  /** Блок New Releases страницы `/game/` — 20 игр (ТЗ п.1). */
  async listNewReleases(): Promise<ParsedList> {
    return parseGameList(await this.http.getJson(newReleasesUrl()));
  }

  /** Очередная страница browse, нумерация с 1 (ТЗ п.2). */
  async listBrowsePage(page: number): Promise<ParsedList> {
    return parseGameList(await this.http.getJson(browsePageUrl(page)));
  }

  async getGameCard(slug: string): Promise<GameCard> {
    return parseGameCard(await this.http.getJson(gameCardUrl(slug)));
  }

  /**
   * Сводная оценка. Для userscore платформа обязательна: без сегмента пути
   * бэкенд отдаёт ведущую платформу, а не запрошенную (§6).
   */
  async getScoreStats(
    kind: ReviewKind,
    slug: string,
    platform: string | null = null,
  ): Promise<ScoreStats> {
    return parseScoreStats(
      await this.http.getJson(scoreStatsUrl(kind, slug, platform)),
      kind,
    );
  }

  /**
   * Отзывы одного вида с пагинацией до `maxReviews`, с дедупликацией по
   * `externalId`. Шаг страницы зависит от вида — см. ниже.
   */
  async listReviews(
    kind: ReviewKind,
    slug: string,
    opts: { platform?: string | null; sentiment?: Sentiment } = {},
  ): Promise<Review[]> {
    const collected: Review[] = [];
    const seen = new Set<string>();

    // Критиков источник отдаёт по 10 независимо от `limit`; пользователей —
    // сколько попросишь. Просить больше потолка бессмысленно, меньше — дорого.
    const pageSize =
      kind === 'critic'
        ? CRITIC_PAGE_SIZE
        : Math.min(this.maxReviews, USER_PAGE_SIZE_MAX);

    for (let offset = 0; offset < this.maxReviews; offset += pageSize) {
      const url = reviewListUrl(kind, slug, {
        platform: opts.platform ?? null,
        offset,
        limit: pageSize,
        sentiment: opts.sentiment ?? 'all',
        sort: 'date',
      });
      const { totalResults, reviews } = parseReviews(await this.http.getJson(url), kind);

      // Порядок у источника нестабилен (§6): страницы могут пересекаться.
      for (const r of reviews) {
        if (seen.has(r.externalId)) continue;
        seen.add(r.externalId);
        collected.push(r);
      }

      const exhausted =
        reviews.length === 0 ||
        (totalResults !== null && offset + pageSize >= totalResults);
      if (exhausted) break;
    }

    return collected.slice(0, this.maxReviews);
  }
}
