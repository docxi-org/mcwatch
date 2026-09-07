import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../index.js';
import { llmRuns } from '../schema.js';
import type { CallMeta } from '../../clients/openrouter.js';

/**
 * Журнал вызовов модели — `docs/ARCHITECTURE.md` §10. Хранит и сырьё, и ответ,
 * и решение кода: карточка обязана уметь показать, из чего она получилась,
 * а не только чем кончилась.
 */

export type LlmStage =
  | 'summary_critic'
  | 'summary_user'
  | 'embedding'
  | 'letsplay_judge'
  | 'letsplay_conclusion';

export interface RecordRunInput {
  gameSlug: string;
  stage: LlmStage;
  subject?: string | null;
  meta: CallMeta;
  /** Что вернулось. `null` — вызов сорвался. */
  output: unknown;
  /** Что код сделал с ответом. Это не то же, что сам ответ. */
  decision: string;
  error?: string | null;
  /** Сколько игр обслужил один вызов: у эмбеддингов пачка общая. */
  batchSize?: number;
}

export function recordRun(db: Db, input: RecordRunInput, now: Date = new Date()): void {
  db.insert(llmRuns)
    .values({
      gameSlug: input.gameSlug,
      stage: input.stage,
      subject: input.subject ?? null,
      model: input.meta.model,
      status: input.error ? 'failed' : 'ok',
      attempts: input.meta.attempts,
      durationMs: input.meta.durationMs,
      promptTokens: input.meta.promptTokens,
      completionTokens: input.meta.completionTokens,
      costUsd: input.meta.costUsd,
      batchSize: input.batchSize ?? 1,
      // Постоянная и переменная части хранятся раздельно: в интерфейсе их
      // показывают по-разному, а склеенную строку потом не разнять.
      input: JSON.stringify({ system: input.meta.system, prompt: input.meta.prompt }),
      output: input.output === null ? null : JSON.stringify(input.output),
      decision: input.decision,
      error: input.error ?? null,
      createdAt: now,
    })
    .run();
}

export interface LlmRunRow {
  id: number;
  stage: LlmStage;
  subject: string | null;
  model: string;
  status: 'ok' | 'failed';
  attempts: number;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  batchSize: number;
  decision: string;
  error: string | null;
  createdAt: Date;
}

/** Список вызовов по игре без тяжёлых полей: сырьё тянется отдельно. */
export function listRuns(db: Db, slug: string): LlmRunRow[] {
  return db
    .select({
      id: llmRuns.id,
      stage: llmRuns.stage,
      subject: llmRuns.subject,
      model: llmRuns.model,
      status: llmRuns.status,
      attempts: llmRuns.attempts,
      durationMs: llmRuns.durationMs,
      promptTokens: llmRuns.promptTokens,
      completionTokens: llmRuns.completionTokens,
      costUsd: llmRuns.costUsd,
      batchSize: llmRuns.batchSize,
      decision: llmRuns.decision,
      error: llmRuns.error,
      createdAt: llmRuns.createdAt,
    })
    .from(llmRuns)
    .where(eq(llmRuns.gameSlug, slug))
    .orderBy(llmRuns.id)
    .all();
}

export interface LlmRunPayload {
  id: number;
  stage: LlmStage;
  subject: string | null;
  system: string;
  prompt: string;
  output: unknown;
}

/** Сырьё и ответ одного вызова. Отдаётся своим запросом: тут килобайты. */
export function getRunPayload(db: Db, slug: string, id: number): LlmRunPayload | null {
  const row = db
    .select({
      id: llmRuns.id,
      stage: llmRuns.stage,
      subject: llmRuns.subject,
      input: llmRuns.input,
      output: llmRuns.output,
    })
    .from(llmRuns)
    .where(and(eq(llmRuns.gameSlug, slug), eq(llmRuns.id, id)))
    .get();

  if (!row) return null;

  let parsed: { system?: string; prompt?: string } = {};
  try {
    parsed = JSON.parse(row.input) as typeof parsed;
  } catch {
    // Битую запись показываем пустой, а не роняем экран.
    parsed = {};
  }

  return {
    id: row.id,
    stage: row.stage,
    subject: row.subject,
    system: parsed.system ?? '',
    prompt: parsed.prompt ?? '',
    output: row.output === null ? null : (JSON.parse(row.output) as unknown),
  };
}

export interface LlmTotals {
  calls: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  costUsd: number;
}

function totalsFrom(db: Db, where?: ReturnType<typeof eq>): LlmTotals {
  const q = db
    .select({
      calls: sql<number>`count(*)`,
      failed: sql<number>`sum(case when ${llmRuns.status} = 'failed' then 1 else 0 end)`,
      promptTokens: sql<number>`coalesce(sum(${llmRuns.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${llmRuns.completionTokens}), 0)`,
      durationMs: sql<number>`coalesce(sum(${llmRuns.durationMs}), 0)`,
      costUsd: sql<number>`coalesce(sum(${llmRuns.costUsd}), 0)`,
    })
    .from(llmRuns);

  const row = where ? q.where(where).get() : q.get();
  return {
    calls: row?.calls ?? 0,
    failed: row?.failed ?? 0,
    promptTokens: row?.promptTokens ?? 0,
    completionTokens: row?.completionTokens ?? 0,
    durationMs: row?.durationMs ?? 0,
    costUsd: row?.costUsd ?? 0,
  };
}

/** Итог по игре — шапка карточки конвейера. */
export function totalsForGame(db: Db, slug: string): LlmTotals {
  return totalsFrom(db, eq(llmRuns.gameSlug, slug));
}

/** Итог по всему сервису — для экрана мониторинга. */
export function totalsForService(db: Db): LlmTotals {
  return totalsFrom(db);
}

/** Когда модель в последний раз что-то делала. */
export function lastRunAt(db: Db): Date | null {
  const row = db
    .select({ ts: llmRuns.createdAt })
    .from(llmRuns)
    .orderBy(desc(llmRuns.id))
    .limit(1)
    .get();
  return row?.ts ?? null;
}
