import { and, count, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Review, ReviewKind } from '../clients/metacritic/index.js';
import type { OpenRouterClient } from '../clients/openrouter.js';
import { SUMMARY_MODEL } from '../config/models.js';
import { componentLogger } from '../config/logger.js';
import type { Db } from '../db/index.js';
import { games, reviews } from '../db/schema.js';
import {
  getSummary,
  refreshReason,
  upsertSummary,
  type RefreshReason,
} from '../db/repo/summaries.js';
import { nullReporter, type Reporter } from './monitor.js';
import { selectForSummary } from './selectReviews.js';

/**
 * Воркер резюме — `docs/ARCHITECTURE.md` §4.1. Проходит игры, у которых есть
 * отзывы, и пересчитывает резюме там, где сработало правило обновления.
 * Ошибка одной игры не роняет прогон.
 */

const KINDS: ReviewKind[] = ['critic', 'user'];

/** Имя воркера в мониторинге. */
export const WORKER = 'summarizer';

export interface SummarizeDeps {
  db: Db;
  client: OpenRouterClient;
  now?: () => Date;
  log?: Logger;
  /** Ограничение на число резюме за прогон; без него — все, кому надо. */
  limit?: number;
  model?: string;
  reporter?: Reporter;
}

export interface SummarizeResult {
  /** Групп (игра+вид) с отзывами вообще. */
  candidates: number;
  written: number;
  /** Пропущено как актуальное. */
  upToDate: number;
  failed: number;
  reasons: Record<string, number>;
  failures: { slug: string; kind: ReviewKind; error: string }[];
}

interface Candidate {
  slug: string;
  title: string;
  kind: ReviewKind;
  reviewCount: number;
}

/**
 * Игры с отзывами и число отзывов каждого вида. Одним запросом, а не по игре:
 * список кандидатов нужен целиком до начала работы.
 */
function findCandidates(db: Db): Candidate[] {
  const out: Candidate[] = [];

  for (const kind of KINDS) {
    const rows = db
      .select({
        slug: reviews.gameSlug,
        title: games.title,
        n: count(),
      })
      .from(reviews)
      .innerJoin(games, eq(games.slug, reviews.gameSlug))
      .where(eq(reviews.kind, kind))
      .groupBy(reviews.gameSlug, games.title)
      .all();

    for (const r of rows) {
      out.push({ slug: r.slug, title: r.title, kind, reviewCount: r.n });
    }
  }

  return out;
}

/** Отзывы группы для передачи модели. */
function loadReviews(db: Db, slug: string, kind: ReviewKind): Review[] {
  return db
    .select()
    .from(reviews)
    .where(and(eq(reviews.gameSlug, slug), eq(reviews.kind, kind)))
    .all()
    .map((r) => ({
      externalId: r.externalId,
      kind: r.kind,
      text: r.text,
      score: r.score,
      scoreMax: r.scoreMax,
      author: r.author,
      date: r.date,
      url: r.url,
      platform: r.platform,
      sentiment: r.sentiment,
    }));
}

export async function runSummarizeOnce(
  deps: SummarizeDeps,
): Promise<SummarizeResult> {
  const { db, client } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? componentLogger('summarizer');
  const model = deps.model ?? SUMMARY_MODEL;
  const report = deps.reporter ?? nullReporter;

  report.started(WORKER);
  const candidates = findCandidates(db);
  const result: SummarizeResult = {
    candidates: candidates.length,
    written: 0,
    upToDate: 0,
    failed: 0,
    reasons: {},
    failures: [],
  };

  log.info({ candidates: candidates.length }, 'прогон резюме начат');

  for (const c of candidates) {
    if (deps.limit !== undefined && result.written >= deps.limit) break;

    // Рассмотрели пару — и это уже работа, даже если обновлять нечего.
    report.checked(WORKER);

    const existing = getSummary(db, c.slug, c.kind);
    const reason: RefreshReason = refreshReason(existing, c.reviewCount, now());

    if (reason === null) {
      result.upToDate++;
      continue;
    }

    report.item(WORKER, `${c.title} · ${c.kind}`);
    try {
      const list = loadReviews(db, c.slug, c.kind);
      // Отзывов нет — резюме нет: выдумывать нечего (CLAUDE.md).
      if (list.length === 0) continue;

      // Модели уходит выборка, а не всё хранилище (§4.1): у иных игр отзывов
      // под сотню, и слать их целиком — лишние деньги и минуты.
      const input = selectForSummary(list, c.kind);
      const summary = await client.summarizeReviews({
        title: c.title,
        kind: c.kind,
        reviews: input,
      });

      // Запоминаем полное число отзывов, а не размер выборки: правило
      // обновления следит за ростом хранилища.
      upsertSummary(db, c.slug, c.kind, summary, model, list.length, now());
      result.written++;
      result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
      report.processed(WORKER);
      log.debug({ slug: c.slug, kind: c.kind, reason }, 'резюме сохранено');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed++;
      result.failures.push({ slug: c.slug, kind: c.kind, error: message });
      report.failed(WORKER);
      report.log(WORKER, 'warn', `резюме не сделано: ${c.slug} · ${c.kind}`, {
        error: message,
      });
      log.warn({ err, slug: c.slug, kind: c.kind }, 'резюме не сделано, идём дальше');
    }
  }

  log.info(
    { written: result.written, upToDate: result.upToDate, failed: result.failed },
    'прогон резюме завершён',
  );
  report.log(
    WORKER,
    'info',
    // Числа стоят после двоеточия: так подпись не приходится склонять.
    `прогон завершён · проверено пар «игра + вид отзывов»: ${candidates.length} · ` +
      `резюме обновлено: ${result.written} · свежих: ${result.upToDate}` +
      (result.failed > 0 ? ` · сбоев: ${result.failed}` : ''),
    {
      checked: candidates.length,
      written: result.written,
      upToDate: result.upToDate,
      failed: result.failed,
    },
  );
  report.finished(WORKER);
  return result;
}
