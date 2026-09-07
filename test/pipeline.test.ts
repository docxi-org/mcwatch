import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenRouterClient } from '../src/clients/openrouter.js';
import type { VideoCandidate, YouTubeClient } from '../src/clients/youtube.js';
import { TranscriptUnavailableError } from '../src/clients/youtube.js';
import { createDb, runMigrations, type DbHandle } from '../src/db/index.js';
import { listCandidates } from '../src/db/repo/letsplayCandidates.js';
import { listRuns, recordRun, totalsForGame } from '../src/db/repo/llmRuns.js';
import { runLetsplayOnce } from '../src/workers/letsplay.js';
import type { PipelineDto } from '../src/api/types.js';
import { asCall, FAKE_META } from './llmCall.js';

/**
 * Прозрачность конвейера — `docs/ARCHITECTURE.md` §10. Проверяется не то, что
 * запись «появилась», а то, что по ней можно восстановить ход дела: сырьё,
 * ответ и решение кода — три разные вещи, и путать их нельзя.
 */

const log = pino({ level: 'silent' });
const at = (iso: string) => () => new Date(iso);

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcwatch-pipe-'));
  handle = createDb(join(dir, 'test.db'));
  runMigrations(handle);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedGame(slug: string, title = `Игра ${slug}`): void {
  handle.sqlite
    .prepare("INSERT INTO games (slug, title, developer, genres) VALUES (?, ?, 'Студия', '[]')")
    .run(slug, title);
}

const video = (id: string, over: Partial<VideoCandidate> = {}): VideoCandidate => ({
  id,
  title: `Ролик ${id}`,
  channel: 'Канал',
  views: 1000,
  durationS: 3600,
  url: `https://www.youtube.com/watch?v=${id}`,
  ...over,
});

// ── Журнал вызовов ─────────────────────────────────────────────────────────

describe('журнал вызовов модели', () => {
  it('хранит сырьё, ответ и решение кода раздельно', () => {
    seedGame('a');
    recordRun(handle.db, {
      gameSlug: 'a',
      stage: 'summary_critic',
      meta: FAKE_META,
      output: { likes: ['бои'] },
      decision: 'резюме сохранено',
    });

    const rows = listRuns(handle.db, 'a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage: 'summary_critic',
      status: 'ok',
      decision: 'резюме сохранено',
      promptTokens: 100,
    });
  });

  it('сорванный вызов записывается тоже: молчащий этап выглядел бы несделанным', () => {
    seedGame('a');
    recordRun(handle.db, {
      gameSlug: 'a',
      stage: 'summary_user',
      meta: FAKE_META,
      output: null,
      decision: 'резюме не сделано',
      error: 'модель недоступна',
    });

    expect(listRuns(handle.db, 'a')[0]).toMatchObject({
      status: 'failed',
      error: 'модель недоступна',
    });
  });

  it('итог по игре складывает токены, время и оценку стоимости', () => {
    seedGame('a');
    for (const stage of ['summary_critic', 'summary_user'] as const) {
      recordRun(handle.db, { gameSlug: 'a', stage, meta: FAKE_META, output: {}, decision: 'ок' });
    }

    expect(totalsForGame(handle.db, 'a')).toMatchObject({
      calls: 2,
      failed: 0,
      promptTokens: 200,
      completionTokens: 40,
      durationMs: 24,
    });
  });

  it('записи уходят вместе с игрой', () => {
    seedGame('a');
    recordRun(handle.db, {
      gameSlug: 'a',
      stage: 'embedding',
      meta: FAKE_META,
      output: {},
      decision: 'ок',
    });

    handle.sqlite.prepare("DELETE FROM games WHERE slug='a'").run();

    expect(listRuns(handle.db, 'a')).toEqual([]);
  });
});

// ── Кандидаты в летсплеи ───────────────────────────────────────────────────

function fakes(opts: {
  candidates?: VideoCandidate[];
  transcripts?: Record<string, string>;
  verdicts?: Record<string, { matches: boolean; confidence: 'high' | 'low'; reason: string }>;
}) {
  const youtube = {
    findCandidates: () => Promise.resolve(opts.candidates ?? []),
    fetchTranscript: (id: string) => {
      const t = opts.transcripts?.[id];
      return t === undefined
        ? Promise.reject(new TranscriptUnavailableError(id, 'расшифровка пуста'))
        : Promise.resolve(t);
    },
  } as unknown as YouTubeClient;

  const llm = {
    judgeVideoMatch: (_g: unknown, v: { title: string }) =>
      Promise.resolve(
        asCall(
          opts.verdicts?.[v.title.replace('Ролик ', '')] ?? {
            matches: true,
            confidence: 'high' as const,
            reason: 'ок',
          },
        ),
      ),
    concludeLetsplay: () =>
      Promise.resolve(asCall({ conclusion: 'понравилось', highlights: [], vibe: 'positive' })),
  } as unknown as OpenRouterClient;

  return { youtube, llm };
}

describe('кандидаты в летсплеи', () => {
  it('сохраняются все рассмотренные, включая отбракованных', async () => {
    seedGame('a');
    await runLetsplayOnce({
      db: handle.db,
      ...fakes({
        candidates: [video('чужой', { views: 9000 }), video('свой', { views: 10 })],
        transcripts: { чужой: 'про другую игру', свой: 'про эту игру' },
        verdicts: {
          чужой: { matches: false, confidence: 'high', reason: 'это Hello Neighbour' },
          свой: { matches: true, confidence: 'high', reason: 'та самая' },
        },
      }),
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    const rows = listCandidates(handle.db, 'a');
    expect(rows.map((r) => [r.videoId, r.outcome])).toEqual([
      ['чужой', 'отбракован: другая игра'],
      ['свой', 'взят'],
    ]);
    // Причина отказа обязана пережить ротацию журнала событий.
    expect(rows[0]?.reason).toContain('Hello Neighbour');
  });

  it('ролик без речи попадает в список с честной причиной, а не пропадает', async () => {
    seedGame('a');
    await runLetsplayOnce({
      db: handle.db,
      ...fakes({ candidates: [video('немой')], transcripts: {} }),
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    expect(listCandidates(handle.db, 'a')[0]).toMatchObject({
      outcome: 'нет расшифровки',
      transcriptChars: null,
      matches: null,
    });
  });

  it('на каждого судимого кандидата приходится своя запись вызова', async () => {
    seedGame('a');
    await runLetsplayOnce({
      db: handle.db,
      ...fakes({
        candidates: [video('раз'), video('два')],
        transcripts: { раз: 'речь', два: 'речь' },
        verdicts: { раз: { matches: false, confidence: 'high', reason: 'другая' } },
      }),
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    const judged = listRuns(handle.db, 'a').filter((r) => r.stage === 'letsplay_judge');
    expect(judged.map((r) => [r.subject, r.decision])).toEqual([
      ['раз', 'отбракован: другая игра'],
      ['два', 'взят'],
    ]);
  });
});

// ── Маршруты ───────────────────────────────────────────────────────────────

describe('GET /api/games/:slug/pipeline', () => {
  it('отдаёт цепочку этапов и объясняет пропущенные', async () => {
    seedGame('пустая', 'Без отзывов');

    const { createApp } = await import('../src/server/app.js');
    const res = await createApp({ db: handle.db }).request('/api/games/пустая/pipeline');
    const body = (await res.json()) as PipelineDto;

    expect(res.status).toBe(200);
    expect(body.stages.map((s) => s.key)).toEqual([
      'crawl',
      'summary_critic',
      'summary_user',
      'embedding',
      'similar',
      'letsplay_search',
      'letsplay_judge',
      'letsplay_conclusion',
    ]);
    // Пропуск — не ошибка, и он обязан объяснять себя словами.
    const critic = body.stages.find((s) => s.key === 'summary_critic');
    expect(critic).toMatchObject({ status: 'skipped' });
    expect(critic?.summary).toContain('резюмировать нечего');
  });

  it('сырьё отдельным запросом: система, запрос и ответ', async () => {
    seedGame('a');
    recordRun(handle.db, {
      gameSlug: 'a',
      stage: 'summary_critic',
      meta: { ...FAKE_META, prompt: 'Отзывы критиков…' },
      output: { summary: 'итог' },
      decision: 'сохранено',
    });
    const id = listRuns(handle.db, 'a')[0]?.id;

    const { createApp } = await import('../src/server/app.js');
    const app = createApp({ db: handle.db });
    const res = await app.request(`/api/games/a/pipeline/runs/${id}`);
    const body = (await res.json()) as { system: string; prompt: string; output: unknown };

    expect(body.prompt).toBe('Отзывы критиков…');
    expect(body.system).toBe('системная часть');
    expect(body.output).toEqual({ summary: 'итог' });
  });

  it('чужой вызов по адресу игры не отдаётся', async () => {
    seedGame('a');
    seedGame('b');
    recordRun(handle.db, {
      gameSlug: 'b',
      stage: 'embedding',
      meta: FAKE_META,
      output: {},
      decision: 'ок',
    });
    const id = listRuns(handle.db, 'b')[0]?.id;

    const { createApp } = await import('../src/server/app.js');
    const res = await createApp({ db: handle.db }).request(`/api/games/a/pipeline/runs/${id}`);

    expect(res.status).toBe(404);
  });

  it('неизвестная игра — 404', async () => {
    const { createApp } = await import('../src/server/app.js');
    const res = await createApp({ db: handle.db }).request('/api/games/нет-такой/pipeline');

    expect(res.status).toBe(404);
  });
});
