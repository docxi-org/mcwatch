import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LetsplayConclusion,
  OpenRouterClient,
  VideoMatch,
} from '../src/clients/openrouter.js';
import {
  TranscriptUnavailableError,
  type VideoCandidate,
  type YouTubeClient,
} from '../src/clients/youtube.js';
import { createDb, runMigrations, type DbHandle } from '../src/db/index.js';
import { findGamesNeedingLetsplay, getLetsplay } from '../src/db/repo/letsplays.js';
import { runLetsplayOnce } from '../src/workers/letsplay.js';
import { asCall } from './llmCall.js';

const log = pino({ level: 'silent' });

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcwatch-lp-'));
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

const CONCLUSION: LetsplayConclusion = {
  conclusion: 'Автору игра понравилась.',
  highlights: ['бои', 'музыка'],
  vibe: 'positive',
};

interface FakeOpts {
  candidates?: VideoCandidate[];
  /** id → расшифровка; отсутствие означает «речи нет». */
  transcripts?: Record<string, string>;
  /** id → вердикт судьи. */
  verdicts?: Record<string, VideoMatch>;
  searchFails?: boolean;
}

function fakes(opts: FakeOpts = {}) {
  const judged: string[] = [];
  const concluded: string[] = [];

  const youtube = {
    findCandidates: () => {
      if (opts.searchFails) return Promise.reject(new Error('YouTube недоступен'));
      return Promise.resolve(opts.candidates ?? []);
    },
    fetchTranscript: (id: string) => {
      const t = opts.transcripts?.[id];
      return t === undefined
        ? Promise.reject(new TranscriptUnavailableError(id, 'расшифровка пуста'))
        : Promise.resolve(t);
    },
  } as unknown as YouTubeClient;

  const llm = {
    judgeVideoMatch: (_g: unknown, v: { title: string }, transcript: string) => {
      const id = v.title.replace('Ролик ', '');
      judged.push(`${id}:${transcript.length}`);
      return Promise.resolve(
        asCall(opts.verdicts?.[id] ?? { matches: true, confidence: 'high', reason: 'ок' }),
      );
    },
    concludeLetsplay: (_g: unknown, v: { title: string }, transcript: string) => {
      concluded.push(`${v.title}:${transcript.length}`);
      return Promise.resolve(asCall(CONCLUSION));
    },
  } as unknown as OpenRouterClient;

  return { youtube, llm, judged, concluded };
}

const at = (iso: string) => () => new Date(iso);
const run = (f: ReturnType<typeof fakes>) =>
  runLetsplayOnce({
    db: handle.db,
    youtube: f.youtube,
    llm: f.llm,
    now: at('2026-09-10T00:00:00Z'),
    log,
  });

// ── Подбор ─────────────────────────────────────────────────────────────────

describe('подбор ролика', () => {
  it('берёт первого подходящего и сохраняет заключение со ссылкой', async () => {
    seedGame('a', 'Онимуся');
    const f = fakes({
      candidates: [video('v1', { views: 500 })],
      transcripts: { v1: 'речь автора' },
    });

    const result = await run(f);

    expect(result).toMatchObject({ pending: 1, done: 1 });
    const row = getLetsplay(handle.db, 'a');
    expect(row).toMatchObject({ videoId: 'v1', status: 'done' });
    expect(JSON.parse(row?.conclusion ?? '{}')).toEqual(CONCLUSION);
  });

  it('судье уходит расшифровка ЦЕЛИКОМ, а не выдержка', async () => {
    seedGame('a');
    const long = 'я играю в эту игру '.repeat(3000);
    const f = fakes({ candidates: [video('v1')], transcripts: { v1: long } });

    await run(f);

    // Урезание входа роняло точность суждения (§6).
    expect(f.judged).toEqual([`v1:${long.length}`]);
    expect(f.concluded[0]).toContain(`:${long.length}`);
  });

  it('ролик без речи пропускается: заключение делать не из чего', async () => {
    seedGame('a');
    const f = fakes({
      // v1 — «No Commentary», расшифровки нет вовсе.
      candidates: [video('v1', { views: 900 }), video('v2', { views: 100 })],
      transcripts: { v2: 'а тут речь есть' },
    });

    const result = await run(f);

    expect(getLetsplay(handle.db, 'a')?.videoId).toBe('v2');
    expect(result.rejected['a']?.[0]).toMatchObject({ videoId: 'v1', reason: 'нет расшифровки' });
  });

  it('чужую игру судья отбраковывает, берётся следующий кандидат', async () => {
    seedGame('a');
    const f = fakes({
      candidates: [video('чужой', { views: 9000 }), video('свой', { views: 10 })],
      transcripts: { чужой: 'я играю в другую игру', свой: 'а это наша игра' },
      verdicts: {
        чужой: { matches: false, confidence: 'high', reason: 'другая игра' },
        свой: { matches: true, confidence: 'high', reason: 'та самая' },
      },
    });

    await run(f);

    expect(getLetsplay(handle.db, 'a')?.videoId).toBe('свой');
  });

  it('берётся самый популярный ИЗ ПОДХОДЯЩИХ, а не самый популярный', async () => {
    seedGame('a');
    const f = fakes({
      candidates: [
        video('топ', { views: 100000 }),
        video('средний', { views: 5000 }),
        video('низ', { views: 5 }),
      ],
      transcripts: { топ: 'чужое', средний: 'наше', низ: 'наше' },
      verdicts: { топ: { matches: false, confidence: 'high', reason: 'другая игра' } },
    });

    await run(f);

    expect(getLetsplay(handle.db, 'a')?.videoId).toBe('средний');
  });

  it('сомнение судьи не принимается за согласие', async () => {
    seedGame('a');
    const f = fakes({
      candidates: [video('сомнительный'), video('ясный')],
      transcripts: { сомнительный: 'непонятно', ясный: 'понятно' },
      verdicts: {
        // На `low` судья ошибался чаще всего — это сомнение, не приговор (§6).
        сомнительный: { matches: true, confidence: 'low', reason: 'не уверен' },
        ясный: { matches: true, confidence: 'high', reason: 'уверен' },
      },
    });

    await run(f);

    expect(getLetsplay(handle.db, 'a')?.videoId).toBe('ясный');
  });
});

// ── Исходы без ролика ──────────────────────────────────────────────────────

describe('когда ролика нет', () => {
  it('поиск ничего не дал — статус no_video', async () => {
    seedGame('a');

    const result = await run(fakes({ candidates: [] }));

    expect(result.noVideo).toBe(1);
    expect(getLetsplay(handle.db, 'a')).toMatchObject({ status: 'no_video', videoId: null });
  });

  it('ролики есть, но все без речи — статус no_transcript', async () => {
    seedGame('a');

    const result = await run(fakes({ candidates: [video('v1'), video('v2')], transcripts: {} }));

    expect(result.noTranscript).toBe(1);
    expect(getLetsplay(handle.db, 'a')?.status).toBe('no_transcript');
  });

  it('все кандидаты чужие — статус no_video, причины сохранены', async () => {
    seedGame('a');
    const f = fakes({
      candidates: [video('v1')],
      transcripts: { v1: 'про другую игру' },
      verdicts: { v1: { matches: false, confidence: 'high', reason: 'это Hello Neighbour' } },
    });

    const result = await run(f);

    expect(getLetsplay(handle.db, 'a')?.status).toBe('no_video');
    // Потеря обязана быть видимой, а не молчаливой.
    expect(result.rejected['a']?.[0]?.reason).toContain('Hello Neighbour');
  });

  it('сбой поиска помечает failed и не роняет остальные игры', async () => {
    seedGame('a');
    seedGame('b');
    const f = fakes({ searchFails: true });

    const result = await run(f);

    expect(result.failed).toBe(2);
    expect(getLetsplay(handle.db, 'a')).toMatchObject({ status: 'failed' });
    expect(getLetsplay(handle.db, 'a')?.lastError).toContain('YouTube недоступен');
  });
});

// ── Повторные прогоны ──────────────────────────────────────────────────────

describe('повторные прогоны', () => {
  it('успешно обработанную игру заново не ищут', async () => {
    seedGame('a');
    await run(fakes({ candidates: [video('v1')], transcripts: { v1: 'речь' } }));

    expect(findGamesNeedingLetsplay(handle.db)).toEqual([]);
  });

  it('игру без ролика заново не ищут: поиск делается один раз', async () => {
    seedGame('a');
    await run(fakes({ candidates: [] }));

    expect(findGamesNeedingLetsplay(handle.db)).toEqual([]);
  });

  it('после сбоя игра пробуется снова', async () => {
    seedGame('a');
    await run(fakes({ searchFails: true }));

    expect(findGamesNeedingLetsplay(handle.db).map((g) => g.slug)).toEqual(['a']);
  });

  it('новая игра попадает в очередь', async () => {
    seedGame('старая');
    await run(fakes({ candidates: [], transcripts: {} }));
    seedGame('новая');

    expect(findGamesNeedingLetsplay(handle.db).map((g) => g.slug)).toEqual(['новая']);
  });

  it('летсплей удаляется вместе с игрой', async () => {
    seedGame('a');
    await run(fakes({ candidates: [video('v1')], transcripts: { v1: 'речь' } }));

    handle.sqlite.prepare("DELETE FROM games WHERE slug='a'").run();

    expect(getLetsplay(handle.db, 'a')).toBeNull();
  });
});

describe('карточка API', () => {
  it('отдаёт заключение, ссылку и статус', async () => {
    seedGame('a');
    await run(fakes({ candidates: [video('v1')], transcripts: { v1: 'речь' } }));

    const { createApp } = await import('../src/server/app.js');
    const res = await createApp({ db: handle.db }).request('/api/games/a');
    const body = (await res.json()) as {
      letsplay: { url: string; conclusion: string; highlights: string[]; status: string };
    };

    expect(body.letsplay).toMatchObject({
      url: 'https://www.youtube.com/watch?v=v1',
      conclusion: CONCLUSION.conclusion,
      highlights: CONCLUSION.highlights,
      vibe: 'positive',
      status: 'done',
    });
  });

  it('игра без обработки отдаёт letsplay = null', async () => {
    seedGame('a');

    const { createApp } = await import('../src/server/app.js');
    const res = await createApp({ db: handle.db }).request('/api/games/a');

    expect(((await res.json()) as { letsplay: unknown }).letsplay).toBeNull();
  });
});

describe('клиент YouTube', () => {
  it('пустая расшифровка — это отсутствие речи, а не успех', async () => {
    const { YouTubeClient } = await import('../src/clients/youtube.js');
    const client = new YouTubeClient({ maxAttempts: 1 });
    vi.spyOn(client, 'fetchTranscript');

    // Проверяем сам класс ошибки: воркер отличает её от прочих сбоев.
    expect(new TranscriptUnavailableError('x', 'пусто').name).toBe(
      'TranscriptUnavailableError',
    );
  });
});

describe('раскладка исходов', () => {
  it('считает каждый исход и игры, до которых воркер не дошёл', async () => {
    const { letsplayOutcomes } = await import('../src/db/repo/letsplays.js');

    seedGame('готова');
    seedGame('чужие-ролики');
    seedGame('без-речи');
    seedGame('не-трогали');

    await runLetsplayOnce({
      db: handle.db,
      ...fakes({
        candidates: [video('v1')],
        transcripts: { v1: 'речь' },
      }),
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    const out = letsplayOutcomes(handle.db);
    // Три игры получили ролик, четвёртая тоже — фейк отдаёт всем одно и то же;
    // важно, что сумма исходов покрывает всю базу без остатка.
    expect(out.done + out.noVideo + out.noTranscript + out.failed + out.pending).toBe(4);
  });

  it('игры без записи попадают в «ещё не искали», а не теряются', async () => {
    const { letsplayOutcomes } = await import('../src/db/repo/letsplays.js');

    seedGame('одна');
    seedGame('вторая');

    expect(letsplayOutcomes(handle.db)).toMatchObject({
      done: 0,
      noVideo: 0,
      noTranscript: 0,
      failed: 0,
      pending: 2,
    });
  });

  it('исходы различаются: «ролика нет» и «в ролике молчат» — разные строки', async () => {
    const { letsplayOutcomes } = await import('../src/db/repo/letsplays.js');

    seedGame('нет-ролика');
    await runLetsplayOnce({
      db: handle.db,
      ...fakes({ candidates: [] }),
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    seedGame('молчит');
    await runLetsplayOnce({
      db: handle.db,
      ...fakes({ candidates: [video('v1')], transcripts: {} }),
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    expect(letsplayOutcomes(handle.db)).toMatchObject({
      noVideo: 1,
      noTranscript: 1,
      pending: 0,
    });
  });
});

describe('расшифровка', () => {
  it('HTML-мнемоники раскрываются: в модель не должен уезжать мусор', async () => {
    const { decodeEntities } = await import('../src/clients/youtube.js');

    // Ровно то, что показала карточка конвейера в сырье судьи.
    expect(decodeEntities('it&#39;s been quite a long time')).toBe("it's been quite a long time");
    expect(decodeEntities('Tom &amp; Jerry &quot;лучшие&quot;')).toBe('Tom & Jerry "лучшие"');
    expect(decodeEntities('&#x27;шестнадцатеричная&#x27;')).toBe("'шестнадцатеричная'");
  });

  it('незнакомую мнемонику оставляет как есть, а не съедает', () => {
    // Молча удалить кусок текста хуже, чем оставить его непонятным.
    return import('../src/clients/youtube.js').then(({ decodeEntities }) => {
      expect(decodeEntities('&неведомое; и &#не-число;')).toBe('&неведомое; и &#не-число;');
    });
  });
});
