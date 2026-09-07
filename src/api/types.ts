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

export interface LetsplayDto {
  /** Ссылка на ролик. `null`, если подходящего не нашлось. */
  url: string | null;
  title: string | null;
  channel: string | null;
  views: number | null;
  durationS: number | null;
  /** Пересказ впечатления автора ролика. */
  conclusion: string | null;
  highlights: string[];
  vibe: 'positive' | 'mixed' | 'negative' | null;
  /**
   * `done` — заключение есть; `no_video` — подходящего ролика не нашлось;
   * `no_transcript` — ролики есть, но без речи; `pending` — ещё не искали;
   * `failed` — попытка сорвалась.
   */
  status: 'pending' | 'no_video' | 'no_transcript' | 'done' | 'failed';
}

export interface GameCardDto {
  slug: string;
  title: string;
  coverUrl: string | null;
  /** Страница игры на самом Metacritic — источник всех данных карточки. */
  metacriticUrl: string;
  /** Страница проигрывателя с трейлером; `null` — трейлера нет. */
  videoUrl: string | null;
  /**
   * Кадр-заставка трейлера. Выводится из адреса проигрывателя, поэтому может
   * не открыться — интерфейс обязан пережить это заглушкой.
   */
  videoPosterUrl: string | null;
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
  /** `null` — игру ещё не обрабатывал воркер летсплеев. */
  letsplay: LetsplayDto | null;
}

export interface PlatformDto {
  platform: string;
  /** Сколько игр в базе имеют эту платформу. */
  gameCount: number;
}

export type SortKey = 'metascore' | 'userscore' | 'date' | 'title';

/** Один вызов модели в цепочке — `docs/ARCHITECTURE.md` §10. */
export interface PipelineRunDto {
  id: number;
  stage: string;
  /** Уточнение внутри этапа: идентификатор ролика у судьи. */
  subject: string | null;
  model: string;
  status: 'ok' | 'failed';
  attempts: number;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Оценка по прайсу из конфига, не факт от провайдера. */
  costUsd: number | null;
  /** Сколько игр обслужил один вызов: у эмбеддингов пачка общая. */
  batchSize: number;
  /** Что код сделал с ответом — это не то же, что сам ответ. */
  decision: string;
  error: string | null;
  createdAt: string;
}

export interface PipelineStageDto {
  key:
    | 'crawl'
    | 'summary_critic'
    | 'summary_user'
    | 'embedding'
    | 'similar'
    | 'letsplay_search'
    | 'letsplay_judge'
    | 'letsplay_conclusion';
  title: string;
  /** `llm` — был вызов модели, `code` — детерминированный этап. */
  kind: 'llm' | 'code';
  /** `skipped` — этап не понадобился; это не ошибка. */
  status: 'done' | 'skipped' | 'failed';
  /** Однострочный итог для ленты этапов. */
  summary: string;
  runs: PipelineRunDto[];
  /** Что показать у этапа без модели. */
  facts: { key: string; value: string }[];
}

export interface PipelineCandidateDto {
  position: number;
  videoId: string;
  title: string;
  channel: string | null;
  views: number | null;
  durationS: number | null;
  /** Длина расшифровки; `null` — получить её не удалось. */
  transcriptChars: number | null;
  matches: boolean | null;
  confidence: string | null;
  reason: string | null;
  outcome: string;
}

export interface PipelineTotalsDto {
  calls: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  costUsd: number;
}

export interface PipelineDto {
  slug: string;
  title: string;
  totals: PipelineTotalsDto;
  stages: PipelineStageDto[];
  candidates: PipelineCandidateDto[];
}
