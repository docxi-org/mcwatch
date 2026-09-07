import type {
  GameCardDto,
  GameListDto,
  PlatformDto,
  SortKey,
  StatusDto,
} from './types.js';

/**
 * Слой запросов. Три маршрута каталога и три мониторинга — больше API не
 * отдаёт, и выдуманных полей у интерфейса быть не должно (`docs/UI-BRIEF.md`).
 */

/** Ошибка с кодом: экраны различают 404, 400 и всё остальное. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    // Сеть отвалилась — это не ответ сервера, и кода у неё нет.
    throw new ApiError(0, err instanceof Error ? err.message : 'сеть недоступна');
  }
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status} на ${path}`);
  return (await res.json()) as T;
}

export interface ListQuery {
  platform: string | null;
  q: string | null;
  sort: SortKey;
  letsplay: boolean;
  trailer: boolean;
  page: number;
  pageSize: number;
}

/** Сколько игр в базе попадает под дополнительные фильтры. */
export interface FacetsDto {
  withLetsplay: number;
  withTrailer: number;
}

export function listQueryToParams(query: ListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.platform) params.set('platform', query.platform);
  if (query.q) params.set('q', query.q);
  params.set('sort', query.sort);
  if (query.letsplay) params.set('letsplay', '1');
  if (query.trailer) params.set('trailer', '1');
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  return params;
}

export function fetchGames(query: ListQuery, signal?: AbortSignal): Promise<GameListDto> {
  return getJson<GameListDto>(`/api/games?${listQueryToParams(query).toString()}`, signal);
}

export function fetchGame(slug: string, signal?: AbortSignal): Promise<GameCardDto> {
  return getJson<GameCardDto>(`/api/games/${encodeURIComponent(slug)}`, signal);
}

export function fetchPlatforms(signal?: AbortSignal): Promise<PlatformDto[]> {
  return getJson<PlatformDto[]>('/api/platforms', signal);
}

export function fetchFacets(signal?: AbortSignal): Promise<FacetsDto> {
  return getJson<FacetsDto>('/api/facets', signal);
}

export function fetchStatus(signal?: AbortSignal): Promise<StatusDto> {
  return getJson<StatusDto>('/api/status', signal);
}

/** Исход принудительного запуска. 409 — не ошибка, а сообщение (§3.4 брифа). */
export type RunOutcome = 202 | 409 | 503 | 'failed';

export async function runCrawl(): Promise<RunOutcome> {
  try {
    const res = await fetch('/api/crawl/run', { method: 'POST' });
    if (res.status === 202 || res.status === 409 || res.status === 503) return res.status;
    return 'failed';
  } catch {
    return 'failed';
  }
}
