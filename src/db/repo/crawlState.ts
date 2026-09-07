import { eq, lt } from 'drizzle-orm';
import type { Db } from '../index.js';
import { crawlState } from '../schema.js';

/**
 * Состояние ротации сбора — `docs/ARCHITECTURE.md` §2. Строка на календарную
 * дату UTC: новая дата = новая строка, то есть «каждый новый день начинаем
 * выбирать заново» получается само, без отдельного сброса.
 */

/** Что обходить в этот заход. */
export type CrawlTarget =
  | { phase: 'landing' }
  | { phase: 'browse'; page: number };

export interface CrawlStateRow {
  date: string;
  phase: 'landing' | 'browse';
  nextPage: number;
  processedSlugs: string[];
}

/** Календарная дата UTC в формате `YYYY-MM-DD`. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Состояние на дату; если строки нет — создаёт начальную. Начальная фаза
 * `landing`: первый заход дня всегда идёт в New Releases (ТЗ п.1).
 */
export function loadOrCreateState(db: Db, date: string): CrawlStateRow {
  const existing = db
    .select()
    .from(crawlState)
    .where(eq(crawlState.date, date))
    .get();

  if (existing) {
    return {
      date: existing.date,
      phase: existing.phase,
      nextPage: existing.nextPage,
      processedSlugs: existing.processedSlugs,
    };
  }

  const fresh: CrawlStateRow = {
    date,
    phase: 'landing',
    nextPage: 1,
    processedSlugs: [],
  };
  db.insert(crawlState).values(fresh).run();
  return fresh;
}

/** Куда идти в этот заход — читается прямо из состояния. */
export function planTarget(state: CrawlStateRow): CrawlTarget {
  return state.phase === 'landing'
    ? { phase: 'landing' }
    : { phase: 'browse', page: state.nextPage };
}

/**
 * Двигает ротацию после захода: landing → browse p.1 → p.2 → … Номер растёт
 * независимо от того, сколько игр оказалось новыми: ТЗ говорит «за каждый
 * заход обрабатывать очередную страницу», а не «пока не наберём новых».
 */
export function advance(state: CrawlStateRow, processed: string[]): CrawlStateRow {
  const seen = new Set([...state.processedSlugs, ...processed]);
  return {
    date: state.date,
    phase: 'browse',
    nextPage: state.phase === 'landing' ? 1 : state.nextPage + 1,
    processedSlugs: [...seen],
  };
}

export function saveState(db: Db, state: CrawlStateRow): void {
  db.insert(crawlState)
    .values(state)
    .onConflictDoUpdate({
      target: crawlState.date,
      set: {
        phase: state.phase,
        nextPage: state.nextPage,
        processedSlugs: state.processedSlugs,
      },
    })
    .run();
}

/** Убирает состояния прошлых дней: они уже ни на что не влияют. */
export function pruneOldStates(db: Db, keepFrom: string): number {
  return db.delete(crawlState).where(lt(crawlState.date, keepFrom)).run().changes;
}
