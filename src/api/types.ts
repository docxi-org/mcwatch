/**
 * Формы ответов API. Держатся отдельно от маршрутов, чтобы бриф для
 * интерфейса и сам интерфейс опирались на один источник правды.
 * Отсутствие данных — всегда `null`, не 0 и не пустая строка.
 */

export interface PlatformScoreDto {
  /** Человекочитаемое имя: «PlayStation 5». */
  platform: string;
  /** Metascore 0–100. */
  metascore: number | null;
  /** Пользовательская оценка 0–10. Со шкалой критиков не смешивать. */
  userscore: number | null;
  criticCount: number | null;
  userCount: number | null;
}

export interface GameListItemDto {
  slug: string;
  title: string;
  coverUrl: string | null;
  releaseDate: string | null;
  developer: string | null;
  genres: string[];
  /** Платформы игры, для значков в списке. */
  platforms: string[];
  /** Лучший Metascore среди платформ; по нему же идёт сортировка. */
  bestMetascore: number | null;
  /** Лучшая пользовательская оценка среди платформ. */
  bestUserscore: number | null;
  /** `failed` означает, что последний обход этой игры не удался. */
  status: 'ok' | 'failed';
}

export interface GameListDto {
  items: GameListItemDto[];
  /** Всего игр, подходящих под фильтр, — не размер страницы. */
  total: number;
  page: number;
  pageSize: number;
}

export interface SummaryDto {
  likes: string[];
  dislikes: string[];
  summary: string;
  /** Сколько отзывов было учтено на момент расчёта. */
  reviewCount: number;
  model: string;
  createdAt: string;
}

export interface SimilarGameDto {
  slug: string;
  title: string;
  coverUrl: string | null;
  bestMetascore: number | null;
  /** Оценка близости 0–1 с небольшим превышением; для отладки, не для показа. */
  score: number;
}

export interface GameCardDto {
  slug: string;
  title: string;
  coverUrl: string | null;
  /** Страница проигрывателя с трейлером; `null` — трейлера нет. */
  videoUrl: string | null;
  developer: string | null;
  publisher: string | null;
  description: string | null;
  genres: string[];
  releaseDate: string | null;
  esrb: string | null;
  status: 'ok' | 'failed';
  platforms: PlatformScoreDto[];
  /** Резюме по видам отзывов. `null` — отзывов нет, и это не ошибка. */
  summaries: {
    critic: SummaryDto | null;
    user: SummaryDto | null;
  };
  /** Сколько отзывов сохранено по видам. */
  reviewCounts: { critic: number; user: number };
  similar: SimilarGameDto[];
}

export interface PlatformDto {
  platform: string;
  /** Сколько игр в базе имеют эту платформу. */
  gameCount: number;
}

export type SortKey = 'metascore' | 'userscore' | 'date' | 'title';
