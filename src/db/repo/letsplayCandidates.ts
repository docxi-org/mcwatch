import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../index.js';
import { letsplayCandidates } from '../schema.js';

/**
 * Рассмотренные кандидаты в летсплеи — все, включая отбракованных
 * (`docs/ARCHITECTURE.md` §10). Раньше отказы жили строкой в журнале событий
 * и исчезали при ротации: причина, по которой ролик не взят, пропадала.
 */

export interface CandidateRow {
  position: number;
  videoId: string;
  title: string;
  channel: string | null;
  views: number | null;
  durationS: number | null;
  transcript: string | null;
  matches: boolean | null;
  confidence: string | null;
  reason: string | null;
  outcome: string;
}

/** Кандидаты переписываются целиком: прогон рассматривает выдачу заново. */
export function replaceCandidates(
  db: Db,
  slug: string,
  rows: CandidateRow[],
  now: Date = new Date(),
): void {
  db.delete(letsplayCandidates).where(eq(letsplayCandidates.gameSlug, slug)).run();
  if (rows.length === 0) return;

  db.insert(letsplayCandidates)
    .values(rows.map((r) => ({ ...r, gameSlug: slug, createdAt: now })))
    .run();
}

/** Без расшифровок: они тяжёлые и тянутся отдельным запросом. */
export function listCandidates(db: Db, slug: string): (Omit<CandidateRow, 'transcript'> & {
  transcriptChars: number | null;
})[] {
  return db
    .select({
      position: letsplayCandidates.position,
      videoId: letsplayCandidates.videoId,
      title: letsplayCandidates.title,
      channel: letsplayCandidates.channel,
      views: letsplayCandidates.views,
      durationS: letsplayCandidates.durationS,
      transcript: letsplayCandidates.transcript,
      matches: letsplayCandidates.matches,
      confidence: letsplayCandidates.confidence,
      reason: letsplayCandidates.reason,
      outcome: letsplayCandidates.outcome,
    })
    .from(letsplayCandidates)
    .where(eq(letsplayCandidates.gameSlug, slug))
    .orderBy(asc(letsplayCandidates.position))
    .all()
    .map(({ transcript, ...rest }) => ({
      ...rest,
      transcriptChars: transcript === null ? null : transcript.length,
    }));
}

/** Расшифровка одного кандидата — то самое «сырьё» для судьи. */
export function getTranscript(db: Db, slug: string, videoId: string): string | null {
  const row = db
    .select({ transcript: letsplayCandidates.transcript })
    .from(letsplayCandidates)
    .where(
      and(eq(letsplayCandidates.gameSlug, slug), eq(letsplayCandidates.videoId, videoId)),
    )
    .get();
  return row?.transcript ?? null;
}
