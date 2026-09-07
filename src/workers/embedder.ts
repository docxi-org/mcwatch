import type { Logger } from 'pino';
import { failedMeta, type OpenRouterClient } from '../clients/openrouter.js';
import { EMBEDDING_MODEL } from '../config/models.js';
import { componentLogger } from '../config/logger.js';
import type { Db } from '../db/index.js';
import {
  findGamesNeedingEmbedding,
  saveEmbedding,
  type PendingEmbedding,
} from '../db/repo/embeddings.js';
import { recordRun } from '../db/repo/llmRuns.js';
import { nullReporter, type Reporter } from './monitor.js';

/**
 * Воркер эмбеддингов — `docs/ARCHITECTURE.md` §4.2. Считает вектор один раз;
 * пересчёт происходит потому, что сборщик обнуляет `embedding` при смене
 * материала. Ошибка одной пачки не роняет прогон.
 */

/** Сколько текстов уходит за один вызов: меньше запросов при том же объёме. */
const BATCH_SIZE = 16;

/** Имя воркера в мониторинге. */
export const WORKER = 'embedder';

export interface EmbedDeps {
  db: Db;
  client: OpenRouterClient;
  log?: Logger;
  batchSize?: number;
  reporter?: Reporter;
  /** Часы. Отдельно — чтобы тесты не зависели от настоящего времени. */
  now?: () => Date;
}

export interface EmbedResult {
  pending: number;
  written: number;
  failed: number;
  failures: { slugs: string[]; error: string }[];
}

/**
 * Материал эмбеддинга. Та же склейка, что и в `repo/games.ts`, но из строки
 * БД, а не из карточки. Описания у игр из browse часто нет (§6) — тогда текст
 * собирается из названия, жанров и разработчика, и игра всё равно попадает в
 * «похожие», а не выпадает из них.
 */
export function embeddingTextOf(game: PendingEmbedding): string {
  return [game.title, (game.genres ?? []).join(', '), game.developer, game.description]
    .filter((p) => !!p)
    .join(' · ');
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runEmbedOnce(deps: EmbedDeps): Promise<EmbedResult> {
  const { db, client } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const log = deps.log ?? componentLogger('embedder');
  const size = deps.batchSize ?? BATCH_SIZE;
  const report = deps.reporter ?? nullReporter;

  report.started(WORKER);
  const pending = findGamesNeedingEmbedding(db);
  const result: EmbedResult = {
    pending: pending.length,
    written: 0,
    failed: 0,
    failures: [],
  };

  log.info({ pending: pending.length }, 'прогон эмбеддингов начат');

  for (const batch of chunk(pending, size)) {
    const slugs = batch.map((g) => g.slug);
    report.checked(WORKER, batch.length);
    report.item(WORKER, `пачка из ${batch.length}`);
    try {
      const texts = batch.map(embeddingTextOf);
      const call = await client.embed(texts);

      for (const [i, game] of batch.entries()) {
        const vector = call.value[i];
        if (!vector) continue;
        saveEmbedding(db, game.slug, vector);
        result.written++;
        report.processed(WORKER);

        // Вызов был общий на всю пачку, но в карточке игры показывать надо её
        // собственный текст. Токены и время при этом остаются пачечными —
        // делить их между играми значило бы придумывать точность.
        recordRun(
          db,
          {
            gameSlug: game.slug,
            stage: 'embedding',
            meta: { ...call.meta, prompt: texts[i] ?? '' },
            output: { dimensions: vector.length },
            decision: `вектор сохранён · ${vector.length} чисел`,
            batchSize: batch.length,
          },
          now(),
        );
      }
      log.debug({ slugs }, 'пачка эмбеддингов сохранена');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed += batch.length;
      result.failures.push({ slugs, error: message });
      report.failed(WORKER, batch.length);
      report.log(WORKER, 'warn', 'пачка не посчитана', { slugs, error: message });
      log.warn({ err, slugs }, 'пачка не посчитана, идём дальше');

      for (const game of batch) {
        recordRun(
          db,
          {
            gameSlug: game.slug,
            stage: 'embedding',
            meta: { ...failedMeta(EMBEDDING_MODEL), prompt: embeddingTextOf(game) },
            output: null,
            decision: 'вектор не посчитан, игра осталась без похожих',
            error: message,
            batchSize: batch.length,
          },
          now(),
        );
      }
    }
  }

  log.info(
    { written: result.written, failed: result.failed },
    'прогон эмбеддингов завершён',
  );
  report.log(
    WORKER,
    'info',
    `прогон завершён · векторов посчитано: ${result.written}` +
      (result.failed > 0 ? ` · сбоев: ${result.failed}` : ''),
    { written: result.written, failed: result.failed },
  );
  report.finished(WORKER);
  return result;
}
