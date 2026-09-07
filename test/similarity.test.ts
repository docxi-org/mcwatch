import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameCard } from '../src/clients/metacritic/index.js';
import type { OpenRouterClient } from '../src/clients/openrouter.js';
import { createDb, runMigrations, type DbHandle } from '../src/db/index.js';
import {
  decodeEmbedding,
  encodeEmbedding,
  findGamesNeedingEmbedding,
  loadSimilarityPool,
} from '../src/db/repo/embeddings.js';
import { upsertGame } from '../src/db/repo/games.js';
import { games } from '../src/db/schema.js';
import { runEmbedOnce, embeddingTextOf } from '../src/workers/embedder.js';
import {
  cosine,
  findSimilar,
  jaccard,
  similarityScore,
  SIMILARITY_THRESHOLD,
  type SimilarityCandidate,
} from '../src/workers/similarity.js';

const log = pino({ level: 'silent' });

const vec = (...xs: number[]) => Float32Array.from(xs);

const candidate = (
  slug: string,
  over: Partial<SimilarityCandidate> = {},
): SimilarityCandidate => ({
  slug,
  embedding: vec(1, 0, 0),
  genres: ['Action'],
  platforms: ['PC'],
  developer: null,
  ...over,
});

// ── Составляющие формулы ───────────────────────────────────────────────────

describe('косинус', () => {
  it('одинаковые направления дают 1, противоположные −1', () => {
    expect(cosine(vec(1, 2, 3), vec(2, 4, 6))).toBeCloseTo(1);
    expect(cosine(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1);
  });

  it('ортогональные дают 0', () => {
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
  });

  it('нулевой вектор и разная длина дают 0, а не NaN', () => {
    expect(cosine(vec(0, 0), vec(1, 1))).toBe(0);
    expect(cosine(vec(1, 0), vec(1, 0, 0))).toBe(0);
    expect(cosine(vec(), vec())).toBe(0);
  });
});

describe('Жаккар', () => {
  it('считает пересечение к объединению без учёта регистра', () => {
    expect(jaccard(['Action', 'RPG'], ['action'])).toBeCloseTo(0.5);
    expect(jaccard(['A', 'B'], ['A', 'B'])).toBe(1);
  });

  it('пустое множество не делает игры похожими', () => {
    // Иначе две игры без жанров получили бы 1 просто от бедности данных.
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['A'], [])).toBe(0);
  });
});

// ── Формула целиком ────────────────────────────────────────────────────────

describe('оценка похожести (§4.2)', () => {
  it('совпадение по всему даёт 1 плюс надбавка за разработчика', () => {
    const a = candidate('a', { developer: 'Capcom' });
    const b = candidate('b', { developer: 'Capcom' });

    expect(similarityScore(a, b)).toBeCloseTo(1.05);
  });

  it('разные жанры и платформы при том же тексте оставляют только вклад текста', () => {
    const a = candidate('a');
    const b = candidate('b', { genres: ['Puzzle'], platforms: ['PS5'] });

    expect(similarityScore(a, b)).toBeCloseTo(0.6);
  });

  it('игра без эмбеддинга не получает текстового вклада', () => {
    const a = candidate('a');
    const b = candidate('b', { embedding: null });

    // Остаются только жанры и платформы: 0.3 + 0.1.
    expect(similarityScore(a, b)).toBeCloseTo(0.4);
  });

  it('две пустые игры не считаются похожими', () => {
    const empty = (slug: string): SimilarityCandidate => ({
      slug,
      embedding: null,
      genres: [],
      platforms: [],
      developer: null,
    });

    expect(similarityScore(empty('a'), empty('b'))).toBe(0);
  });
});

describe('подбор похожих', () => {
  const target = candidate('сама');
  const pool = [
    target,
    candidate('очень-похожа'),
    candidate('чужая', {
      embedding: vec(0, 1, 0),
      genres: ['Puzzle'],
      platforms: ['PS5'],
    }),
  ];

  it('исключает саму игру из выдачи', () => {
    expect(findSimilar(target, pool).map((f) => f.slug)).not.toContain('сама');
  });

  it('отсекает всё ниже порога', () => {
    const found = findSimilar(target, pool);

    expect(found.map((f) => f.slug)).toEqual(['очень-похожа']);
    expect(found.every((f) => f.score >= SIMILARITY_THRESHOLD)).toBe(true);
  });

  it('ограничивает выдачу и сортирует по убыванию оценки', () => {
    const many = Array.from({ length: 9 }, (_, i) => candidate(`похожа-${i}`));

    const found = findSimilar(target, many, 5);

    expect(found).toHaveLength(5);
    const scores = found.map((f) => f.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it('при равных оценках порядок устойчив', () => {
    const many = Array.from({ length: 6 }, (_, i) => candidate(`к-${i}`));

    expect(findSimilar(target, many)).toEqual(findSimilar(target, [...many].reverse()));
  });

  it('пустой пул даёт пустой блок, а не ошибку', () => {
    expect(findSimilar(candidate('одна'), [])).toEqual([]);
  });
});

// ── Хранение вектора ───────────────────────────────────────────────────────

describe('вектор в BLOB', () => {
  it('переживает запись и чтение без потерь', () => {
    const v = Float32Array.from([0.5, -0.25, 1, 0]);

    expect(Array.from(decodeEmbedding(encodeEmbedding(v)))).toEqual(Array.from(v));
  });
});

// ── Воркер ─────────────────────────────────────────────────────────────────

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcwatch-emb-'));
  handle = createDb(join(dir, 'test.db'));
  runMigrations(handle);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const card = (slug: string, over: Partial<GameCard> = {}): GameCard => ({
  slug,
  title: `Игра ${slug}`,
  description: `описание ${slug}`,
  developer: 'Разработчик',
  publisher: null,
  genres: ['Action'],
  releaseDate: null,
  esrb: null,
  coverUrl: null,
  videoUrl: null,
  platforms: [],
  ...over,
});

function fakeEmbedder() {
  const batches: string[][] = [];
  const embed = vi.fn((texts: string[]) => {
    batches.push(texts);
    return Promise.resolve(texts.map((_, i) => Float32Array.from([i, 1, 0])));
  });
  return { client: { embed } as unknown as OpenRouterClient, batches };
}

const now = new Date('2026-09-10T00:00:00Z');

describe('воркер эмбеддингов', () => {
  it('считает вектор всем играм без него', async () => {
    upsertGame(handle.db, card('a'), now);
    upsertGame(handle.db, card('b'), now);

    const { client, batches } = fakeEmbedder();
    const result = await runEmbedOnce({ db: handle.db, client, log });

    expect(result).toMatchObject({ pending: 2, written: 2, failed: 0 });
    expect(batches[0]).toHaveLength(2);
    expect(findGamesNeedingEmbedding(handle.db)).toEqual([]);
  });

  it('второй прогон ничего не пересчитывает', async () => {
    upsertGame(handle.db, card('a'), now);
    await runEmbedOnce({ db: handle.db, client: fakeEmbedder().client, log });

    const second = fakeEmbedder();
    const result = await runEmbedOnce({ db: handle.db, client: second.client, log });

    expect(result.pending).toBe(0);
    expect(second.batches).toEqual([]);
  });

  it('изменение описания обнуляет вектор, и он считается заново', async () => {
    upsertGame(handle.db, card('a'), now);
    await runEmbedOnce({ db: handle.db, client: fakeEmbedder().client, log });

    upsertGame(handle.db, card('a', { description: 'совсем другое' }), now);

    expect(findGamesNeedingEmbedding(handle.db).map((g) => g.slug)).toEqual(['a']);
  });

  it('повторный обход без изменений вектор сохраняет', async () => {
    upsertGame(handle.db, card('a'), now);
    await runEmbedOnce({ db: handle.db, client: fakeEmbedder().client, log });

    upsertGame(handle.db, card('a'), new Date('2026-09-11T00:00:00Z'));

    expect(findGamesNeedingEmbedding(handle.db)).toEqual([]);
  });

  it('игра без описания эмбеддинг всё равно получает', async () => {
    upsertGame(handle.db, card('шлак', { description: null, developer: null }), now);

    const { client, batches } = fakeEmbedder();
    const result = await runEmbedOnce({ db: handle.db, client, log });

    expect(result.written).toBe(1);
    // Текст собрался из названия и жанра — игра не выпадет из «похожих».
    expect(batches[0]?.[0]).toBe('Игра шлак · Action');
  });

  it('сбой пачки не роняет остальные', async () => {
    for (const s of ['a', 'b', 'c']) upsertGame(handle.db, card(s), now);

    let call = 0;
    const client = {
      embed: vi.fn((texts: string[]) => {
        call++;
        return call === 1
          ? Promise.reject(new Error('провайдер лёг'))
          : Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0])));
      }),
    } as unknown as OpenRouterClient;

    const result = await runEmbedOnce({ db: handle.db, client, log, batchSize: 1 });

    expect(result).toMatchObject({ pending: 3, written: 2, failed: 1 });
    expect(result.failures[0]?.error).toContain('провайдер лёг');
  });

  it('пул для похожих отдаёт только игры с вектором', () => {
    upsertGame(handle.db, card('c-вектором'), now);
    upsertGame(handle.db, card('без-вектора'), now);
    handle.db
      .update(games)
      .set({ embedding: encodeEmbedding(vec(1, 0, 0)) })
      .run();
    handle.sqlite
      .prepare("UPDATE games SET embedding = NULL WHERE slug = 'без-вектора'")
      .run();

    expect(loadSimilarityPool(handle.db).map((p) => p.slug)).toEqual(['c-вектором']);
  });
});

describe('материал эмбеддинга', () => {
  it('склеивает название, жанры, разработчика и описание', () => {
    expect(
      embeddingTextOf({
        slug: 'x',
        title: 'Игра',
        genres: ['Action', 'RPG'],
        developer: 'Студия',
        description: 'Описание',
        descriptionHash: null,
      }),
    ).toBe('Игра · Action, RPG · Студия · Описание');
  });

  it('пропускает пустые части, а не оставляет разделители', () => {
    expect(
      embeddingTextOf({
        slug: 'x',
        title: 'Игра',
        genres: null,
        developer: null,
        description: null,
        descriptionHash: null,
      }),
    ).toBe('Игра');
  });
});
