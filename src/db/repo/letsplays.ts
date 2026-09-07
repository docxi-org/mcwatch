import { eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../index.js';
import { games, letsplays } from '../schema.js';

/**
 * Летсплеи — `docs/ARCHITECTURE.md` §4.3. Строка заводится на каждую игру,
 * которую пытались обработать: «не нашли» и «не пробовали» должны различаться.
 */

export type LetsplayStatus = 'pending' | 'no_video' | 'no_transcript' | 'done' | 'failed';

export interface LetsplayRow {
  gameSlug: string;
  videoId: string | null;
  title: string | null;
  channel: string | null;
  views: number | null;
  durationS: number | null;
  conclusion: string | null;
  status: LetsplayStatus;
  lastError: string | null;
}

export interface PendingGame {
  slug: string;
  title: string;
  developer: string | null;
  genres: string[] | null;
  description: string | null;
}

/**
 * Игры, которым ещё не искали летсплей. Поиск делается один раз при первом
 * появлении игры (§4.3): повторять его каждый час бессмысленно и дорого.
 * Неудачные (`failed`) пробуются снова — там могла быть временная ошибка.
 */
export function findGamesNeedingLetsplay(db: Db, limit = 20): PendingGame[] {
  return db
    .select({
      slug: games.slug,
      title: games.title,
      developer: games.developer,
      genres: games.genres,
      description: games.description,
    })
    .from(games)
    .leftJoin(letsplays, eq(letsplays.gameSlug, games.slug))
    .where(or(isNull(letsplays.gameSlug), eq(letsplays.status, 'failed')))
    .limit(limit)
    .all();
}

export function saveLetsplay(
  db: Db,
  slug: string,
  row: Omit<LetsplayRow, 'gameSlug'>,
  now: Date,
): void {
  const values = { ...row, updatedAt: now };
  db.insert(letsplays)
    .values({ gameSlug: slug, ...values })
    .onConflictDoUpdate({ target: letsplays.gameSlug, set: values })
    .run();
}

export function getLetsplay(db: Db, slug: string): LetsplayRow | null {
  const row = db.select().from(letsplays).where(eq(letsplays.gameSlug, slug)).get();
  if (!row) return null;
  return {
    gameSlug: row.gameSlug,
    videoId: row.videoId,
    title: row.title,
    channel: row.channel,
    views: row.views,
    durationS: row.durationS,
    conclusion: row.conclusion,
    status: row.status,
    lastError: row.lastError,
  };
}

/** Сводка по статусам — для мониторинга и отчётов. */
export function letsplayStats(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db
    .select({ status: letsplays.status, n: sql<number>`count(*)` })
    .from(letsplays)
    .groupBy(letsplays.status)
    .all()) {
    out[r.status] = r.n;
  }
  return out;
}

/** Раскладка по исходам. `pending` — игры, до которых воркер ещё не дошёл. */
export interface LetsplayOutcomes {
  done: number;
  noVideo: number;
  noTranscript: number;
  failed: number;
  pending: number;
}

/**
 * Сколько игр каким исходом закончились. Счётчик воркера считает только
 * заключения, поэтому без этой раскладки «обработано 6» при полусотне
 * рассмотренных игр выглядит поломкой (решение владельца 07.09.2026).
 */
export function letsplayOutcomes(db: Db): LetsplayOutcomes {
  const rows = db
    .select({ status: letsplays.status, n: sql<number>`count(*)` })
    .from(letsplays)
    .groupBy(letsplays.status)
    .all();

  const by = (status: LetsplayStatus): number =>
    rows.find((r) => r.status === status)?.n ?? 0;

  const untouched = db
    .select({ n: sql<number>`count(*)` })
    .from(games)
    .where(sql`not exists (select 1 from ${letsplays} where ${letsplays.gameSlug} = ${games.slug})`)
    .get();

  return {
    done: by('done'),
    noVideo: by('no_video'),
    noTranscript: by('no_transcript'),
    failed: by('failed'),
    // «Ещё не искали» — это и строка со статусом pending, и её отсутствие.
    pending: by('pending') + (untouched?.n ?? 0),
  };
}
