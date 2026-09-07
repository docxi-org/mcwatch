import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  GameCard,
  ListedGame,
  MetacriticClient,
  ScoreStats,
} from '../src/clients/metacritic/index.js';
import { createDb, runMigrations, type DbHandle } from '../src/db/index.js';
import { crawlState, gamePlatforms, games } from '../src/db/schema.js';
import { runCrawlOnce } from '../src/workers/crawler.js';

/** Логи в тестах не нужны, но и глушить их молча не стоит — уровень явный. */
const log = pino({ level: 'silent' });

// ── Подменённый Metacritic ────────────────────────────────────────────────

function listed(slug: string): ListedGame {
  return {
    slug,
    title: `Игра ${slug}`,
    releaseDate: '2026-09-01',
    coverUrl: `https://x/${slug}.jpg`,
    metascore: 80,
    genres: ['Action'],
  };
}

function card(slug: string, platforms: string[] = ['playstation-5']): GameCard {
  return {
    slug,
    title: `Игра ${slug}`,
    description: `описание ${slug}`,
    developer: 'Разработчик',
    publisher: 'Издатель',
    genres: ['Action'],
    releaseDate: '2026-09-01',
    esrb: 'M',
    coverUrl: `https://x/${slug}.jpg`,
    videoUrl: `https://cdn.jwplayer.com/players/${slug}.html`,
    platforms: platforms.map((p, i) => ({
      name: p.toUpperCase(),
      slug: p,
      metascore: 80 + i,
      criticCount: 10 + i,
      isLead: i === 0,
    })),
  };
}

interface FakeOptions {
  landing?: string[];
  browse?: Record<number, string[]>;
  cardPlatforms?: Record<string, string[]>;
  failCardFor?: Set<string>;
  failUserScoreFor?: Set<string>;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = { list: [] as string[], cards: [] as string[], stats: [] as string[] };

  const client = {
    listNewReleases: () => {
      calls.list.push('landing');
      return Promise.resolve({
        totalResults: 100,
        games: (opts.landing ?? []).map(listed),
        skipped: 0,
      });
    },
    listBrowsePage: (page: number) => {
      calls.list.push(`browse:${page}`);
      return Promise.resolve({
        totalResults: 1000,
        games: (opts.browse?.[page] ?? []).map(listed),
        skipped: 0,
      });
    },
    getGameCard: (slug: string) => {
      calls.cards.push(slug);
      if (opts.failCardFor?.has(slug)) {
        return Promise.reject(new Error(`карточка ${slug} недоступна`));
      }
      return Promise.resolve(card(slug, opts.cardPlatforms?.[slug]));
    },
    getScoreStats: (_kind: string, slug: string, platform: string | null) => {
      calls.stats.push(`${slug}/${platform ?? '-'}`);
      if (opts.failUserScoreFor?.has(slug)) {
        return Promise.reject(new Error('оценки пользователей недоступны'));
      }
      return Promise.resolve({ score: 8.5, max: 10, reviewCount: 42 } as ScoreStats);
    },
  };

  return { client: client as unknown as MetacriticClient, calls };
}

// ── Обвязка ────────────────────────────────────────────────────────────────

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcwatch-crawl-'));
  handle = createDb(join(dir, 'test.db'));
  runMigrations(handle);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const at = (iso: string) => () => new Date(iso);
const allGames = () => handle.db.select().from(games).all();
const allPlatforms = () => handle.db.select().from(gamePlatforms).all();
const state = () => handle.db.select().from(crawlState).all();

// ── Ротация ────────────────────────────────────────────────────────────────

describe('ротация списков', () => {
  it('первый заход дня идёт в New Releases', async () => {
    const { client, calls } = fakeClient({ landing: ['a', 'b'] });

    const result = await runCrawlOnce({
      db: handle.db,
      client,
      now: at('2026-09-07T10:00:00Z'),
      log,
    });

    expect(calls.list).toEqual(['landing']);
    expect(result.target).toEqual({ phase: 'landing' });
    expect(result.saved).toBe(2);
  });

  it('следующие заходы того же дня идут по страницам browse', async () => {
    const { client, calls } = fakeClient({
      landing: ['a'],
      browse: { 1: ['b'], 2: ['c'] },
    });
    const deps = { db: handle.db, client, now: at('2026-09-07T10:00:00Z'), log };

    await runCrawlOnce(deps);
    await runCrawlOnce(deps);
    const third = await runCrawlOnce(deps);

    expect(calls.list).toEqual(['landing', 'browse:1', 'browse:2']);
    expect(third.target).toEqual({ phase: 'browse', page: 2 });
  });

  it('смена даты возвращает к New Releases', async () => {
    const { client, calls } = fakeClient({ landing: ['a'], browse: { 1: ['b'] } });
    const base = { db: handle.db, client, log };

    await runCrawlOnce({ ...base, now: at('2026-09-07T10:00:00Z') });
    await runCrawlOnce({ ...base, now: at('2026-09-07T11:00:00Z') });
    await runCrawlOnce({ ...base, now: at('2026-09-08T00:30:00Z') });

    expect(calls.list).toEqual(['landing', 'browse:1', 'landing']);
    expect(state().map((s) => s.date)).toEqual(['2026-09-07', '2026-09-08']);
  });

  it('страница растёт, даже если новых игр на ней не оказалось', async () => {
    const { client, calls } = fakeClient({ landing: [], browse: { 1: [], 2: [] } });
    const deps = { db: handle.db, client, now: at('2026-09-07T10:00:00Z'), log };

    await runCrawlOnce(deps);
    await runCrawlOnce(deps);
    await runCrawlOnce(deps);

    expect(calls.list).toEqual(['landing', 'browse:1', 'browse:2']);
  });
});

// ── «Сегодня не обрабатывал» ───────────────────────────────────────────────

describe('игры, уже обработанные сегодня', () => {
  it('не запрашиваются повторно в тот же день', async () => {
    const { client, calls } = fakeClient({
      landing: ['a', 'b'],
      browse: { 1: ['b', 'c'] },
    });
    const deps = { db: handle.db, client, now: at('2026-09-07T10:00:00Z'), log };

    await runCrawlOnce(deps);
    const second = await runCrawlOnce(deps);

    expect(calls.cards).toEqual(['a', 'b', 'c']);
    expect(second.alreadyProcessedToday).toBe(1);
    expect(second.saved).toBe(1);
  });

  it('назавтра та же игра обрабатывается снова и обновляется', async () => {
    const { client, calls } = fakeClient({ landing: ['a'] });
    const base = { db: handle.db, client, log };

    await runCrawlOnce({ ...base, now: at('2026-09-07T10:00:00Z') });
    await runCrawlOnce({ ...base, now: at('2026-09-08T10:00:00Z') });

    expect(calls.cards).toEqual(['a', 'a']);
    expect(allGames()).toHaveLength(1);
  });
});

// ── Запись ─────────────────────────────────────────────────────────────────

describe('сохранение карточки', () => {
  it('кладёт все поля ТЗ, включая оба скора по платформе', async () => {
    const { client } = fakeClient({
      landing: ['a'],
      cardPlatforms: { a: ['playstation-5', 'pc'] },
    });

    await runCrawlOnce({
      db: handle.db,
      client,
      now: at('2026-09-07T10:00:00Z'),
      log,
    });

    expect(allGames()[0]).toMatchObject({
      slug: 'a',
      title: 'Игра a',
      coverUrl: 'https://x/a.jpg',
      videoUrl: 'https://cdn.jwplayer.com/players/a.html',
      developer: 'Разработчик',
      description: 'описание a',
      genres: ['Action'],
      status: 'ok',
    });
    expect(allPlatforms()).toEqual([
      expect.objectContaining({
        platform: 'PLAYSTATION-5',
        metascore: 80,
        userscore: 8.5,
        userCount: 42,
      }),
      expect.objectContaining({ platform: 'PC', metascore: 81, userscore: 8.5 }),
    ]);
  });

  it('повторная встреча обновляет строку и не плодит дубли', async () => {
    const { client } = fakeClient({ landing: ['a'] });
    const base = { db: handle.db, client, log };

    await runCrawlOnce({ ...base, now: at('2026-09-07T10:00:00Z') });
    await runCrawlOnce({ ...base, now: at('2026-09-09T10:00:00Z') });

    const rows = allGames();
    expect(rows).toHaveLength(1);
    // first_seen сохраняется, last_crawled двигается.
    expect(rows[0]?.firstSeen).toEqual(new Date('2026-09-07T10:00:00Z'));
    expect(rows[0]?.lastCrawled).toEqual(new Date('2026-09-09T10:00:00Z'));
  });

  it('исчезнувшая платформа удаляется, оставшаяся обновляется', async () => {
    const first = fakeClient({
      landing: ['a'],
      cardPlatforms: { a: ['playstation-5', 'pc'] },
    });
    await runCrawlOnce({
      db: handle.db,
      client: first.client,
      now: at('2026-09-07T10:00:00Z'),
      log,
    });

    const second = fakeClient({ landing: ['a'], cardPlatforms: { a: ['pc'] } });
    await runCrawlOnce({
      db: handle.db,
      client: second.client,
      now: at('2026-09-08T10:00:00Z'),
      log,
    });

    expect(allPlatforms().map((p) => p.platform)).toEqual(['PC']);
  });
});

// ── Устойчивость ───────────────────────────────────────────────────────────

describe('ошибка одного элемента не роняет обход', () => {
  it('падение карточки помечает игру failed, остальные сохраняются', async () => {
    const { client } = fakeClient({
      landing: ['a', 'bad', 'c'],
      failCardFor: new Set(['bad']),
    });

    const result = await runCrawlOnce({
      db: handle.db,
      client,
      now: at('2026-09-07T10:00:00Z'),
      log,
    });

    expect(result).toMatchObject({ saved: 2, failed: 1 });
    expect(result.failures[0]?.slug).toBe('bad');

    const rows = allGames();
    expect(rows).toHaveLength(3);
    const bad = rows.find((r) => r.slug === 'bad');
    expect(bad).toMatchObject({ status: 'failed', title: 'Игра bad' });
    expect(bad?.lastError).toContain('карточка bad недоступна');
  });

  it('упавшая игра считается обработанной и не блокирует следующий заход', async () => {
    const { client, calls } = fakeClient({
      landing: ['bad'],
      browse: { 1: ['bad', 'c'] },
      failCardFor: new Set(['bad']),
    });
    const deps = { db: handle.db, client, now: at('2026-09-07T10:00:00Z'), log };

    await runCrawlOnce(deps);
    await runCrawlOnce(deps);

    expect(calls.cards).toEqual(['bad', 'c']);
  });

  it('недоступный userscore не теряет платформу с metascore', async () => {
    const { client } = fakeClient({
      landing: ['a'],
      failUserScoreFor: new Set(['a']),
    });

    const result = await runCrawlOnce({
      db: handle.db,
      client,
      now: at('2026-09-07T10:00:00Z'),
      log,
    });

    expect(result.saved).toBe(1);
    expect(allPlatforms()[0]).toMatchObject({
      platform: 'PLAYSTATION-5',
      metascore: 80,
      // Нет данных — null, не 0 (CLAUDE.md, «Правила кода»).
      userscore: null,
      userCount: null,
    });
  });

  it('неудача не затирает поля, собранные ранее успешно', async () => {
    const good = fakeClient({ landing: ['a'] });
    await runCrawlOnce({
      db: handle.db,
      client: good.client,
      now: at('2026-09-07T10:00:00Z'),
      log,
    });

    const broken = fakeClient({ landing: ['a'], failCardFor: new Set(['a']) });
    await runCrawlOnce({
      db: handle.db,
      client: broken.client,
      now: at('2026-09-08T10:00:00Z'),
      log,
    });

    expect(allGames()[0]).toMatchObject({
      status: 'failed',
      developer: 'Разработчик',
      description: 'описание a',
    });
  });
});
