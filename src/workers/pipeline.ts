import { desc } from 'drizzle-orm';
import type { Logger } from 'pino';
import { MetacriticClient } from '../clients/metacritic/index.js';
import { MissingApiKeyError, OpenRouterClient } from '../clients/openrouter.js';
import { componentLogger } from '../config/logger.js';
import type { Db } from '../db/index.js';
import { games } from '../db/schema.js';
import { runCrawlOnce } from './crawler.js';
import { runEmbedOnce } from './embedder.js';
import { Scheduler, type Stage } from './scheduler.js';
import { runSummarizeOnce } from './summarizer.js';

/**
 * Часовой цикл сервиса: обход → резюме → эмбеддинги. Порядок не произвольный —
 * резюме нужны собранные отзывы, эмбеддингам нужны описания из обхода.
 */

export const HOUR_MS = 60 * 60 * 1000;

/** Когда обход был в последний раз — по самой свежей отметке в играх. */
export function lastCrawlAt(db: Db): Date | null {
  const row = db
    .select({ at: games.lastCrawled })
    .from(games)
    .orderBy(desc(games.lastCrawled))
    .limit(1)
    .get();
  return row?.at ?? null;
}

export interface PipelineOptions {
  db: Db;
  intervalMs?: number;
  log?: Logger;
}

/**
 * Собирает этапы. Клиент LLM создаётся один раз: если ключа нет, этапы с
 * моделью выключаются с предупреждением, а обход всё равно работает — сбор
 * данных не должен зависеть от наличия ключа.
 */
export function createStages(db: Db, log: Logger): Stage[] {
  const metacritic = new MetacriticClient();
  const stages: Stage[] = [
    {
      name: 'crawl',
      run: async () => {
        await runCrawlOnce({ db, client: metacritic, log });
      },
    },
  ];

  let llm: OpenRouterClient | null = null;
  try {
    llm = new OpenRouterClient();
  } catch (err) {
    if (!(err instanceof MissingApiKeyError)) throw err;
    log.warn('нет OPENROUTER_API_KEY: резюме и эмбеддинги в цикле отключены');
  }

  if (llm) {
    const client = llm;
    stages.push(
      {
        name: 'summarize',
        run: async () => {
          await runSummarizeOnce({ db, client, log });
        },
      },
      {
        name: 'embed',
        run: async () => {
          await runEmbedOnce({ db, client, log });
        },
      },
    );
  }

  return stages;
}

export function createScheduler(opts: PipelineOptions): Scheduler {
  const log = opts.log ?? componentLogger('pipeline');
  return new Scheduler({
    stages: createStages(opts.db, log),
    intervalMs: opts.intervalMs ?? HOUR_MS,
    lastRunAt: () => lastCrawlAt(opts.db),
    log,
  });
}
