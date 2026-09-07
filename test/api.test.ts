import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameCardDto, GameListDto, PlatformDto } from '../src/api/types.js';
import { createDb, runMigrations, type DbHandle } from '../src/db/index.js';
import { encodeEmbedding } from '../src/db/repo/embeddings.js';
import { createApp } from '../src/server/app.js';

/**
 * API проверяется через `app.request()` на временной БД: порт не открывается,
 * сети нет. Требования — `docs/TASK.md`, раздел «веб-интерфейс».
 */

let dir: string;
let handle: DbHandle;
let app: Hono;

interface SeedGame {
  slug: string;
  title: string;
  releaseDate?: string | null;
  developer?: string | null;
  genres?: string[];
  platforms?: { name: string; meta?: number | null; user?: number | null }[];
  embedding?: number[];
  status?: 'ok' | 'failed';
}

function seed(g: SeedGame): void {
  handle.sqlite
    .prepare(
      `INSERT INTO games (slug, title, release_date, developer, genres, status,
                          cover_url, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      g.slug,
      g.title,
      g.releaseDate ?? null,
      g.developer ?? null,
      JSON.stringify(g.genres ?? []),
      g.status ?? 'ok',
      `https://cover/${g.slug}.jpg`,
      g.embedding ? encodeEmbedding(Float32Array.from(g.embedding)) : null,
    );

  for (const p of g.platforms ?? []) {
    handle.sqlite
      .prepare(
        `INSERT INTO game_platforms (game_slug, platform, metascore, userscore)
         VALUES (?, ?, ?, ?)`,
      )
      .run(g.slug, p.name, p.meta ?? null, p.user ?? null);
  }
}

function seedSummary(slug: string, kind: 'critic' | 'user'): void {
  handle.sqlite
    .prepare(
      `INSERT INTO summaries (game_slug, kind, likes, dislikes, summary, model,
                              review_count_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      slug,
      kind,
      JSON.stringify(['нравится']),
      JSON.stringify(['не нравится']),
      `итог ${kind}`,
      'test-model',
      7,
    );
}

function seedReview(slug: string, kind: 'critic' | 'user', id: string): void {
  handle.sqlite
    .prepare(
      `INSERT INTO reviews (game_slug, kind, external_id, score_max, text)
       VALUES (?, ?, ?, ?, 'текст')`,
    )
    .run(slug, kind, id, kind === 'critic' ? 100 : 10);
}

/**
 * Запрос к приложению с объявлением ожидаемой формы ответа. Параметр типа
 * используется только в возвращаемом значении — здесь это и есть смысл:
 * вызывающий говорит, чем должен оказаться JSON.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcwatch-api-'));
  handle = createDb(join(dir, 'test.db'));
  runMigrations(handle);
  app = createApp(handle.db);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Список ─────────────────────────────────────────────────────────────────

describe('GET /api/games', () => {
  beforeEach(() => {
    seed({
      slug: 'alpha',
      title: 'Alpha Strike',
      releaseDate: '2026-09-01',
      genres: ['Action'],
      platforms: [{ name: 'PC', meta: 90, user: 8.5 }],
    });
    seed({
      slug: 'beta',
      title: 'Beta Quest',
      releaseDate: '2026-09-05',
      platforms: [
        { name: 'PlayStation 5', meta: 70, user: 9.4 },
        { name: 'PC', meta: 75, user: 6.0 },
      ],
    });
    seed({ slug: 'gamma', title: 'Gamma Ray', releaseDate: '2026-08-20' });
  });

  it('отдаёт все игры с общим числом', async () => {
    const { status, body } = await get<GameListDto>('/api/games');

    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.page).toBe(1);
  });

  it('по умолчанию сортирует по дате, свежие сверху', async () => {
    const { body } = await get<GameListDto>('/api/games');

    expect(body.items.map((i) => i.slug)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('рейтинг игры — максимум по платформам, не среднее', async () => {
    const { body } = await get<GameListDto>('/api/games?sort=metascore');

    expect(body.items.map((i) => [i.slug, i.bestMetascore])).toEqual([
      ['alpha', 90],
      ['beta', 75],
      ['gamma', null],
    ]);
  });

  it('игры без оценки уходят в конец, а не возглавляют рейтинг', async () => {
    const { body } = await get<GameListDto>('/api/games?sort=metascore');

    expect(body.items.at(-1)?.slug).toBe('gamma');
  });

  it('пользовательская оценка сортируется своей шкалой, отдельно от критиков', async () => {
    const { body } = await get<GameListDto>('/api/games?sort=userscore');

    // По критикам beta ниже alpha, по игрокам — выше.
    expect(body.items.map((i) => i.slug)).toEqual(['beta', 'alpha', 'gamma']);
    expect(body.items[0]?.bestUserscore).toBe(9.4);
  });

  it('фильтрует по платформе', async () => {
    const { body } = await get<GameListDto>('/api/games?platform=PlayStation%205');

    expect(body.items.map((i) => i.slug)).toEqual(['beta']);
    expect(body.total).toBe(1);
  });

  it('ищет по части названия без учёта регистра', async () => {
    const { body } = await get<GameListDto>('/api/games?q=QUES');

    expect(body.items.map((i) => i.slug)).toEqual(['beta']);
  });

  it('фильтр и поиск применяются вместе', async () => {
    const { body } = await get<GameListDto>('/api/games?q=a&platform=PC');

    expect(body.items.map((i) => i.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('ничего не найдено — пустой список, а не ошибка', async () => {
    const { status, body } = await get<GameListDto>('/api/games?q=такогонет');

    expect(status).toBe(200);
    expect(body).toMatchObject({ items: [], total: 0 });
  });

  it('листает страницами, общее число не меняется', async () => {
    const first = await get<GameListDto>('/api/games?pageSize=2&page=1');
    const second = await get<GameListDto>('/api/games?pageSize=2&page=2');

    expect(first.body.items).toHaveLength(2);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.total).toBe(3);
    const slugs = [...first.body.items, ...second.body.items].map((i) => i.slug);
    expect(new Set(slugs).size).toBe(3);
  });

  it('перечисляет платформы игры для значков в списке', async () => {
    const { body } = await get<GameListDto>('/api/games?q=beta');

    expect(body.items[0]?.platforms).toEqual(['PC', 'PlayStation 5']);
  });

  it('негодные параметры дают 400 с указанием поля', async () => {
    const { status, body } = await get<{ error: string; details: unknown[] }>(
      '/api/games?sort=выдумка',
    );

    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
    expect(body.details).not.toHaveLength(0);
  });

  it('размер страницы ограничен сверху', async () => {
    const { status } = await get('/api/games?pageSize=100000');

    expect(status).toBe(400);
  });
});

// ── Карточка ───────────────────────────────────────────────────────────────

describe('GET /api/games/:slug', () => {
  beforeEach(() => {
    seed({
      slug: 'alpha',
      title: 'Alpha Strike',
      developer: 'Студия',
      genres: ['Action'],
      platforms: [
        { name: 'PC', meta: 90, user: 8.5 },
        { name: 'PlayStation 5', meta: 88, user: null },
      ],
      embedding: [1, 0, 0],
    });
    seed({
      slug: 'близкая',
      title: 'Almost Alpha',
      genres: ['Action'],
      platforms: [{ name: 'PC', meta: 80 }],
      embedding: [1, 0, 0],
    });
    seed({
      slug: 'далёкая',
      title: 'Nothing Alike',
      genres: ['Puzzle'],
      platforms: [{ name: 'PS5', meta: 60 }],
      embedding: [0, 1, 0],
    });
  });

  it('отдаёт все поля карточки из ТЗ', async () => {
    const { status, body } = await get<GameCardDto>('/api/games/alpha');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      slug: 'alpha',
      title: 'Alpha Strike',
      developer: 'Студия',
      genres: ['Action'],
    });
    expect(body.platforms).toEqual([
      { platform: 'PC', metascore: 90, userscore: 8.5, criticCount: null, userCount: null },
      {
        platform: 'PlayStation 5',
        metascore: 88,
        userscore: null,
        criticCount: null,
        userCount: null,
      },
    ]);
  });

  it('резюме нет — null по обоим видам, и это не ошибка', async () => {
    const { body } = await get<GameCardDto>('/api/games/alpha');

    expect(body.summaries).toEqual({ critic: null, user: null });
    expect(body.reviewCounts).toEqual({ critic: 0, user: 0 });
  });

  it('резюме и счётчики отзывов отдаются по видам раздельно', async () => {
    seedSummary('alpha', 'critic');
    seedReview('alpha', 'critic', 'c1');
    seedReview('alpha', 'user', 'u1');
    seedReview('alpha', 'user', 'u2');

    const { body } = await get<GameCardDto>('/api/games/alpha');

    expect(body.summaries.critic).toMatchObject({
      likes: ['нравится'],
      dislikes: ['не нравится'],
      summary: 'итог critic',
      reviewCount: 7,
    });
    expect(body.summaries.user).toBeNull();
    expect(body.reviewCounts).toEqual({ critic: 1, user: 2 });
  });

  it('похожие отдаются с названием и обложкой, сама игра исключена', async () => {
    const { body } = await get<GameCardDto>('/api/games/alpha');

    expect(body.similar.map((s) => s.slug)).toEqual(['близкая']);
    expect(body.similar[0]).toMatchObject({
      title: 'Almost Alpha',
      bestMetascore: 80,
    });
    expect(body.similar[0]?.coverUrl).toContain('близкая');
  });

  it('похожих нет — пустой массив, а не null', async () => {
    const { body } = await get<GameCardDto>('/api/games/далёкая');

    expect(body.similar).toEqual([]);
  });

  it('неизвестный slug даёт 404 в JSON', async () => {
    const { status, body } = await get<{ error: string }>('/api/games/неттакой');

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });
});

// ── Платформы ──────────────────────────────────────────────────────────────

describe('GET /api/platforms', () => {
  it('перечисляет только платформы, которые есть в базе, со счётчиком', async () => {
    seed({ slug: 'a', title: 'A', platforms: [{ name: 'PC' }, { name: 'PS5' }] });
    seed({ slug: 'b', title: 'B', platforms: [{ name: 'PC' }] });

    const { status, body } = await get<PlatformDto[]>('/api/platforms');

    expect(status).toBe(200);
    expect(body).toEqual([
      { platform: 'PC', gameCount: 2 },
      { platform: 'PS5', gameCount: 1 },
    ]);
  });

  it('пустая база — пустой справочник', async () => {
    expect((await get<PlatformDto[]>('/api/platforms')).body).toEqual([]);
  });
});

describe('health остаётся доступным без БД', () => {
  it('приложение без базы всё равно отвечает на проверку живости', async () => {
    const res = await createApp().request('/api/health');

    expect(res.status).toBe(200);
  });
});
