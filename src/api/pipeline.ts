import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { getGame, getReviewCounts, getSummaries } from '../db/repo/catalog.js';
import { loadSimilarityPool } from '../db/repo/embeddings.js';
import { listCandidates } from '../db/repo/letsplayCandidates.js';
import { getLetsplay } from '../db/repo/letsplays.js';
import { getRunPayload, listRuns, totalsForGame, type LlmRunRow } from '../db/repo/llmRuns.js';
import { findSimilar } from '../workers/similarity.js';
import type { PipelineDto, PipelineRunDto, PipelineStageDto } from './types.js';

/**
 * Как получилась карточка — `docs/ARCHITECTURE.md` §10. Отдаёт цепочку
 * этапов: что уходило в модель, что она вернула, что с ответом сделал код.
 *
 * Сырьё не едет вместе с оглавлением: у судьи это расшифровка на полсотни
 * килобайт, и тянуть её вместе со списком незачем.
 */

/** Время наружу уходит строкой ISO, как и во всех остальных ответах API. */
function toDto(run: LlmRunRow): PipelineRunDto {
  return { ...run, createdAt: run.createdAt.toISOString() };
}

function llmStage(
  key: PipelineStageDto['key'],
  title: string,
  rows: LlmRunRow[],
  whenEmpty: string,
): PipelineStageDto {
  const runs = rows.map(toDto);
  if (runs.length === 0) {
    return { key, title, kind: 'llm', status: 'skipped', summary: whenEmpty, runs, facts: [] };
  }

  const failed = runs.filter((r) => r.status === 'failed').length;
  const last = runs[runs.length - 1];
  return {
    key,
    title,
    kind: 'llm',
    status: failed === runs.length ? 'failed' : 'done',
    summary: last?.decision ?? '',
    runs,
    facts: [],
  };
}

export function createPipelineRoutes(db: Db): Hono {
  const app = new Hono();

  app.get('/games/:slug/pipeline', (c) => {
    const slug = c.req.param('slug');
    const game = getGame(db, slug);
    if (!game) return c.json({ error: 'not_found' }, 404);

    const runs = listRuns(db, slug);
    const byStage = (stage: LlmRunRow['stage']): LlmRunRow[] =>
      runs.filter((r) => r.stage === stage);

    const counts = getReviewCounts(db, slug);
    const summaries = getSummaries(db, slug);
    const summaryNote = (kind: 'critic' | 'user', reviews: number): string => {
      if (reviews === 0) return 'отзывов нет — резюмировать нечего';
      return summaries[kind]
        ? 'резюме есть, но сделано до того, как мы начали записывать вызовы'
        : 'резюме ещё не считалось';
    };
    const candidates = listCandidates(db, slug);
    const letsplay = getLetsplay(db, slug);

    const pool = loadSimilarityPool(db);
    const target = pool.find((p) => p.slug === slug);
    const similar = target ? findSimilar(target, pool) : [];

    const stages: PipelineStageDto[] = [
      {
        key: 'crawl',
        title: 'Сбор карточки',
        kind: 'code',
        status: game.status === 'failed' ? 'failed' : 'done',
        summary: `${counts.critic + counts.user} отзывов сохранено`,
        runs: [],
        facts: [
          { key: 'Источник', value: `metacritic.com/game/${slug}/` },
          { key: 'Отзывы критиков', value: String(counts.critic) },
          { key: 'Отзывы игроков', value: String(counts.user) },
          { key: 'Описание', value: game.description ? 'есть' : 'Metacritic не публикует' },
          { key: 'Состояние обхода', value: game.status === 'failed' ? 'сорвался' : 'в порядке' },
        ],
      },
      llmStage(
        'summary_critic',
        'Резюме критиков',
        byStage('summary_critic'),
        summaryNote('critic', counts.critic),
      ),
      llmStage(
        'summary_user',
        'Резюме игроков',
        byStage('summary_user'),
        summaryNote('user', counts.user),
      ),
      llmStage('embedding', 'Вектор описания', byStage('embedding'), 'вектор ещё не считался'),
      {
        key: 'similar',
        title: 'Похожие игры',
        kind: 'code',
        status: target ? 'done' : 'skipped',
        summary: target
          ? `${similar.length} из ${pool.length - 1} прошли порог`
          : 'без вектора похожие не считаются',
        runs: [],
        facts: similar.map((s) => ({ key: s.slug, value: s.score.toFixed(3) })),
      },
      {
        key: 'letsplay_search',
        title: 'Поиск летсплеев',
        kind: 'code',
        status: candidates.length > 0 ? 'done' : 'skipped',
        summary:
          candidates.length > 0
            ? `${candidates.length} кандидатов, по убыванию просмотров`
            : 'поиск ещё не делался',
        runs: [],
        facts: candidates.map((v) => ({
          key: `${v.position}. ${v.title}`,
          value: v.outcome,
        })),
      },
      llmStage(
        'letsplay_judge',
        'Судья роликов',
        byStage('letsplay_judge'),
        candidates.length === 0 ? 'кандидатов не было' : 'судья не вызывался',
      ),
      llmStage(
        'letsplay_conclusion',
        'Заключение по летсплею',
        byStage('letsplay_conclusion'),
        letsplay?.status === 'done'
          ? 'заключение есть, но сделано до того, как мы начали записывать вызовы'
          : 'подходящего ролика не нашлось',
      ),
    ];

    return c.json({
      slug,
      title: game.title,
      totals: totalsForGame(db, slug),
      stages,
      candidates,
    } satisfies PipelineDto);
  });

  /** Сырьё и ответ одного вызова: здесь килобайты, поэтому отдельным запросом. */
  app.get('/games/:slug/pipeline/runs/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'bad_request' }, 400);

    const payload = getRunPayload(db, c.req.param('slug'), id);
    if (!payload) return c.json({ error: 'not_found' }, 404);
    return c.json(payload);
  });

  return app;
}
