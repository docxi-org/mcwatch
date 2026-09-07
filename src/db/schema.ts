import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

/**
 * Схема — `docs/ARCHITECTURE.md` §3. Отсутствующие данные хранятся как NULL,
 * не как 0 и не как пустая строка (CLAUDE.md, «Правила кода»).
 */

export const gameStatus = ['ok', 'failed'] as const;
export const reviewKind = ['critic', 'user'] as const;
export const reviewSentiment = ['positive', 'mixed', 'negative'] as const;
export const crawlPhase = ['landing', 'browse'] as const;
export const jobStatus = ['queued', 'running', 'done', 'failed'] as const;
export const workerState = ['idle', 'running', 'error'] as const;
export const transcriptSource = ['captions', 'whisper'] as const;
export const llmStage = [
  'summary_critic',
  'summary_user',
  'embedding',
  'letsplay_judge',
  'letsplay_conclusion',
] as const;
export const llmRunStatus = ['ok', 'failed'] as const;
export const letsplayStatus = [
  'pending',
  'no_video',
  'no_transcript',
  'done',
  'failed',
] as const;

const now = sql`(unixepoch() * 1000)`;

export const games = sqliteTable(
  'games',
  {
    slug: text('slug').primaryKey(),
    title: text('title').notNull(),
    coverUrl: text('cover_url'),
    /** ID медиа jwplayer либо прямая ссылка; null — трейлера нет. */
    videoUrl: text('video_url'),
    developer: text('developer'),
    publisher: text('publisher'),
    genres: text('genres', { mode: 'json' }).$type<string[]>(),
    description: text('description'),
    /** Календарная дата релиза в ISO (`YYYY-MM-DD`), не момент времени. */
    releaseDate: text('release_date'),
    esrb: text('esrb'),
    /** Хеш описания: смена → пересчёт эмбеддинга (§4.2). */
    descriptionHash: text('description_hash'),
    embedding: blob('embedding', { mode: 'buffer' }),
    firstSeen: integer('first_seen', { mode: 'timestamp_ms' })
      .notNull()
      .default(now),
    lastCrawled: integer('last_crawled', { mode: 'timestamp_ms' }),
    status: text('status', { enum: gameStatus }).notNull().default('ok'),
    lastError: text('last_error'),
  },
  (t) => [
    index('games_last_crawled_idx').on(t.lastCrawled),
    index('games_title_idx').on(t.title),
  ],
);

export const gamePlatforms = sqliteTable(
  'game_platforms',
  {
    gameSlug: text('game_slug')
      .notNull()
      .references(() => games.slug, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    /** 0–100. */
    metascore: integer('metascore'),
    /** 0–10, дробный. С `metascore` не смешивать. */
    userscore: real('userscore'),
    criticCount: integer('critic_count'),
    userCount: integer('user_count'),
  },
  (t) => [
    primaryKey({ columns: [t.gameSlug, t.platform] }),
    index('game_platforms_platform_idx').on(t.platform),
  ],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameSlug: text('game_slug')
      .notNull()
      .references(() => games.slug, { onDelete: 'cascade' }),
    kind: text('kind', { enum: reviewKind }).notNull(),
    /** Идентификатор отзыва у Metacritic — основа дедупликации. */
    externalId: text('external_id').notNull(),
    score: real('score'),
    /** 100 для критиков, 10 для пользователей. */
    scoreMax: integer('score_max').notNull(),
    author: text('author'),
    platform: text('platform'),
    date: text('date'),
    text: text('text').notNull(),
    sentiment: text('sentiment', { enum: reviewSentiment }),
    url: text('url'),
  },
  (t) => [
    unique('reviews_external_uq').on(t.gameSlug, t.kind, t.externalId),
    index('reviews_game_kind_idx').on(t.gameSlug, t.kind),
  ],
);

export const summaries = sqliteTable(
  'summaries',
  {
    gameSlug: text('game_slug')
      .notNull()
      .references(() => games.slug, { onDelete: 'cascade' }),
    kind: text('kind', { enum: reviewKind }).notNull(),
    likes: text('likes', { mode: 'json' }).$type<string[]>().notNull(),
    dislikes: text('dislikes', { mode: 'json' }).$type<string[]>().notNull(),
    summary: text('summary').notNull(),
    model: text('model').notNull(),
    /** Сколько отзывов было на момент расчёта — вход правила обновления (§4.1). */
    reviewCountAt: integer('review_count_at').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(now),
  },
  (t) => [primaryKey({ columns: [t.gameSlug, t.kind] })],
);

export const letsplays = sqliteTable('letsplays', {
  gameSlug: text('game_slug')
    .primaryKey()
    .references(() => games.slug, { onDelete: 'cascade' }),
  videoId: text('video_id'),
  title: text('title'),
  channel: text('channel'),
  views: integer('views'),
  durationS: integer('duration_s'),
  transcriptSource: text('transcript_source', { enum: transcriptSource }),
  conclusion: text('conclusion'),
  status: text('status', { enum: letsplayStatus }).notNull().default('pending'),
  lastError: text('last_error'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(now),
});

export const crawlState = sqliteTable('crawl_state', {
  /** Календарная дата UTC `YYYY-MM-DD`; смена даты — сброс ротации (§2). */
  date: text('date').primaryKey(),
  phase: text('phase', { enum: crawlPhase }).notNull().default('landing'),
  nextPage: integer('next_page').notNull().default(1),
  processedSlugs: text('processed_slugs', { mode: 'json' })
    .$type<string[]>()
    .notNull(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }),
    status: text('status', { enum: jobStatus }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(now),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    error: text('error'),
  },
  (t) => [index('jobs_status_type_idx').on(t.status, t.type)],
);

export const workerStatus = sqliteTable('worker_status', {
  worker: text('worker').primaryKey(),
  state: text('state', { enum: workerState }).notNull().default('idle'),
  currentItem: text('current_item'),
  /**
   * Сколько единиц воркер РАССМОТРЕЛ. Всегда ≥ `processedTotal`: честный
   * простой («проверил 33 пары, обновлять нечего») иначе неотличим от
   * поломки — на этом споткнулся владелец 07.09.2026.
   */
  checkedTotal: integer('checked_total').notNull().default(0),
  processedTotal: integer('processed_total').notNull().default(0),
  failedTotal: integer('failed_total').notNull().default(0),
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
});

/**
 * Каждый вызов модели — строкой. Здесь и сырьё, и ответ, и что с ответом
 * сделал код: карточка обязана уметь показать, из чего она получилась
 * (`docs/ARCHITECTURE.md` §10). Оценка стоимости — именно оценка, по прайсу
 * из конфига, а не факт от провайдера.
 */
export const llmRuns = sqliteTable(
  'llm_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameSlug: text('game_slug')
      .notNull()
      .references(() => games.slug, { onDelete: 'cascade' }),
    stage: text('stage', { enum: llmStage }).notNull(),
    /** Уточнение внутри этапа: идентификатор ролика у судьи. */
    subject: text('subject'),
    model: text('model').notNull(),
    status: text('status', { enum: llmRunStatus }).notNull(),
    attempts: integer('attempts').notNull().default(1),
    durationMs: integer('duration_ms').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    costUsd: real('cost_usd'),
    /**
     * Сколько игр обслужил один вызов. У эмбеддингов пачка общая, и делить
     * её токены между играми значило бы придумывать точность.
     */
    batchSize: integer('batch_size').notNull().default(1),
    /** Что ушло в модель, дословно. */
    input: text('input').notNull(),
    /** Что вернулось, как есть. */
    output: text('output'),
    /** Что с ответом сделал код — это не то же, что сам ответ. */
    decision: text('decision').notNull(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [index('llm_runs_game_idx').on(t.gameSlug, t.id)],
);

/**
 * Рассмотренные кандидаты в летсплеи — все, включая отбракованных. Раньше
 * отказы жили строкой в журнале событий и исчезали при ротации, а вместе с
 * ними исчезала причина, по которой ролик не взят.
 */
export const letsplayCandidates = sqliteTable(
  'letsplay_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameSlug: text('game_slug')
      .notNull()
      .references(() => games.slug, { onDelete: 'cascade' }),
    /** Место в выдаче по убыванию просмотров, с единицы. */
    position: integer('position').notNull(),
    videoId: text('video_id').notNull(),
    title: text('title').notNull(),
    channel: text('channel'),
    views: integer('views'),
    durationS: integer('duration_s'),
    /** Расшифровка целиком; NULL — получить не удалось. */
    transcript: text('transcript'),
    matches: integer('matches', { mode: 'boolean' }),
    confidence: text('confidence'),
    reason: text('reason'),
    /** Итог по кандидату словами: «взят», «отбракован», «нет расшифровки». */
    outcome: text('outcome').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [unique('letsplay_candidates_game_video').on(t.gameSlug, t.videoId)],
);

export const eventsLog = sqliteTable(
  'events_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts', { mode: 'timestamp_ms' }).notNull().default(now),
    worker: text('worker').notNull(),
    level: text('level').notNull(),
    message: text('message').notNull(),
    data: text('data', { mode: 'json' }),
  },
  (t) => [index('events_log_ts_idx').on(t.ts)],
);

export const schema = {
  games,
  gamePlatforms,
  reviews,
  summaries,
  letsplays,
  crawlState,
  jobs,
  workerStatus,
  eventsLog,
  llmRuns,
  letsplayCandidates,
};
