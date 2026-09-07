import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Review } from '../src/clients/metacritic/index.js';
import type { OpenRouterClient, ReviewSummary } from '../src/clients/openrouter.js';
import { createDb, runMigrations, type DbHandle } from '../src/db/index.js';
import {
  refreshReason,
  REFRESH_MAX_AGE_DAYS,
  type StoredSummary,
} from '../src/db/repo/summaries.js';
import { games, reviews, summaries } from '../src/db/schema.js';
import {
  selectForSummary,
  SUMMARY_INPUT_LIMIT,
} from '../src/workers/selectReviews.js';
import { Monitor } from '../src/workers/monitor.js';
import { runSummarizeOnce } from '../src/workers/summarizer.js';

const log = pino({ level: 'silent' });

// ── Правило обновления: чистая функция, ни сети, ни часов ──────────────────

describe('правило обновления резюме (§4.1)', () => {
  const now = new Date('2026-09-10T00:00:00Z');
  const existing = (
    reviewCountAt: number,
    createdAt: string,
  ): Pick<StoredSummary, 'reviewCountAt' | 'createdAt'> => ({
    reviewCountAt,
    createdAt: new Date(createdAt),
  });

  it('резюме нет — считаем', () => {
    expect(refreshReason(null, 5, now)).toBe('missing');
  });

  it('отзывов стало на 20% больше — пересчитываем', () => {
    expect(refreshReason(existing(100, '2026-09-09T00:00:00Z'), 120, now)).toBe(
      'grew_by_ratio',
    );
  });

  it('отзывов стало на 10 больше — пересчитываем даже при малом росте в долях', () => {
    // 500 → 510: рост 2%, порог по доле не сработал бы.
    expect(refreshReason(existing(500, '2026-09-09T00:00:00Z'), 510, now)).toBe(
      'grew_by_count',
    );
  });

  it('прошло 7 дней — пересчитываем, даже если отзывы не менялись', () => {
    expect(refreshReason(existing(10, '2026-09-03T00:00:00Z'), 10, now)).toBe('stale');
  });

  it('ничего не изменилось и срок не вышел — НЕ пересчитываем', () => {
    expect(refreshReason(existing(10, '2026-09-09T00:00:00Z'), 10, now)).toBeNull();
    // Порогов два, и не сработать должны оба: +9 меньше десяти, а 109 не
    // дотягивает до 120. Хватит любого — и пересчёт уже нужен.
    expect(refreshReason(existing(100, '2026-09-09T00:00:00Z'), 109, now)).toBeNull();
    expect(refreshReason(existing(500, '2026-09-09T00:00:00Z'), 509, now)).toBeNull();
  });

  it('порог «+10» срабатывает раньше долевого на больших числах', () => {
    // 100 → 119 это всего +19%, но уже +19 штук.
    expect(refreshReason(existing(100, '2026-09-09T00:00:00Z'), 119, now)).toBe(
      'grew_by_count',
    );
  });

  it('на самой границе срока пересчитываем, за миг до неё — нет', () => {
    const day = 24 * 60 * 60 * 1000;
    const born = new Date(now.getTime() - REFRESH_MAX_AGE_DAYS * day);
    const almost = new Date(born.getTime() + 1);

    expect(refreshReason({ reviewCountAt: 5, createdAt: born }, 5, now)).toBe('stale');
    expect(refreshReason({ reviewCountAt: 5, createdAt: almost }, 5, now)).toBeNull();
  });

  it('уменьшение числа отзывов пересчёт не запускает', () => {
    expect(refreshReason(existing(50, '2026-09-09T00:00:00Z'), 30, now)).toBeNull();
  });
});

// ── Воркер ─────────────────────────────────────────────────────────────────

const ANSWER: ReviewSummary = {
  likes: ['боевая система', 'визуал'],
  dislikes: ['повторяющиеся боссы'],
  summary: 'В целом хвалят.',
};

function fakeLlm(over: Partial<{ fail: Set<string> }> = {}) {
  const calls: { title: string; kind: string; n: number }[] = [];
  const summarizeReviews = vi.fn(
    (input: { title: string; kind: string; reviews: unknown[] }) => {
      calls.push({ title: input.title, kind: input.kind, n: input.reviews.length });
      if (over.fail?.has(input.kind)) {
        return Promise.reject(new Error('модель недоступна'));
      }
      return Promise.resolve(ANSWER);
    },
  );
  return { client: { summarizeReviews } as unknown as OpenRouterClient, calls };
}

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcwatch-sum-'));
  handle = createDb(join(dir, 'test.db'));
  runMigrations(handle);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(slug: string, counts: { critic?: number; user?: number }): void {
  handle.sqlite
    .prepare('INSERT INTO games (slug, title) VALUES (?, ?)')
    .run(slug, `Игра ${slug}`);
  const ins = handle.sqlite.prepare(
    `INSERT INTO reviews (game_slug, kind, external_id, score_max, text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [kind, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      ins.run(slug, kind, `${kind}-${i}`, kind === 'critic' ? 100 : 10, `текст ${i}`);
    }
  }
}

const at = (iso: string) => () => new Date(iso);
const allSummaries = () => handle.db.select().from(summaries).all();

describe('воркер резюме', () => {
  it('делает по резюме на каждый вид отзывов, вместе по всем платформам', async () => {
    seed('a', { critic: 4, user: 3 });

    const { client, calls } = fakeLlm();
    const result = await runSummarizeOnce({
      db: handle.db,
      client,
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    expect(result).toMatchObject({ candidates: 2, written: 2, failed: 0 });
    expect(calls).toEqual([
      { title: 'Игра a', kind: 'critic', n: 4 },
      { title: 'Игра a', kind: 'user', n: 3 },
    ]);

    const rows = allSummaries();
    expect(rows.map((r) => r.kind).sort()).toEqual(['critic', 'user']);
    expect(rows[0]).toMatchObject({
      gameSlug: 'a',
      likes: ANSWER.likes,
      dislikes: ANSWER.dislikes,
      summary: ANSWER.summary,
      reviewCountAt: 4,
    });
  });

  it('игра без отзывов резюме не получает', async () => {
    handle.sqlite.prepare("INSERT INTO games (slug,title) VALUES ('пусто','Пусто')").run();

    const { client, calls } = fakeLlm();
    const result = await runSummarizeOnce({
      db: handle.db,
      client,
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    expect(result.candidates).toBe(0);
    expect(calls).toEqual([]);
    expect(allSummaries()).toEqual([]);
  });

  it('второй прогон подряд ничего не пересчитывает', async () => {
    seed('a', { critic: 4 });
    const deps = { db: handle.db, now: at('2026-09-10T00:00:00Z'), log };

    await runSummarizeOnce({ ...deps, client: fakeLlm().client });
    const second = fakeLlm();
    const result = await runSummarizeOnce({ ...deps, client: second.client });

    expect(second.calls).toEqual([]);
    expect(result).toMatchObject({ written: 0, upToDate: 1 });
  });

  it('прогон без работы всё равно докладывает, что рассмотрел', async () => {
    // Владелец спросил «почему summarizer обработал 0» — потому что счётчик
    // считал результат и молчал о работе. Теперь молчания нет.
    seed('a', { critic: 4, user: 3 });
    const deps = { db: handle.db, now: at('2026-09-10T00:00:00Z'), log };
    await runSummarizeOnce({ ...deps, client: fakeLlm().client });

    const monitor = new Monitor(handle.db);
    const checked = vi.spyOn(monitor, 'checked');
    const processed = vi.spyOn(monitor, 'processed');

    const result = await runSummarizeOnce({
      ...deps,
      client: fakeLlm().client,
      reporter: monitor,
    });

    expect(result).toMatchObject({ written: 0, upToDate: 2 });
    expect(checked).toHaveBeenCalledTimes(2);
    expect(processed).not.toHaveBeenCalled();
    expect(monitor.statuses()[0]).toMatchObject({
      worker: 'summarizer',
      checkedTotal: 2,
      processedTotal: 0,
    });
  });

  it('после прироста отзывов пересчитывает и запоминает новое число', async () => {
    seed('a', { critic: 10 });
    const deps = { db: handle.db, now: at('2026-09-10T00:00:00Z'), log };
    await runSummarizeOnce({ ...deps, client: fakeLlm().client });

    const ins = handle.sqlite.prepare(
      `INSERT INTO reviews (game_slug, kind, external_id, score_max, text)
       VALUES ('a','critic',?,100,'ещё')`,
    );
    for (let i = 0; i < 3; i++) ins.run(`extra-${i}`);

    const second = fakeLlm();
    const result = await runSummarizeOnce({ ...deps, client: second.client });

    // 10 → 13 это +30%, порог по доле сработал.
    expect(result.reasons).toEqual({ grew_by_ratio: 1 });
    expect(second.calls[0]?.n).toBe(13);
    expect(allSummaries()[0]?.reviewCountAt).toBe(13);
  });

  it('сбой модели на одной группе не роняет остальные', async () => {
    seed('a', { critic: 2, user: 2 });

    const { client } = fakeLlm({ fail: new Set(['critic']) });
    const result = await runSummarizeOnce({
      db: handle.db,
      client,
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    expect(result).toMatchObject({ written: 1, failed: 1 });
    expect(result.failures[0]).toMatchObject({ slug: 'a', kind: 'critic' });
    expect(allSummaries().map((r) => r.kind)).toEqual(['user']);
  });

  it('--limit ограничивает число вызовов модели за прогон', async () => {
    seed('a', { critic: 2, user: 2 });
    seed('b', { critic: 2 });

    const { client, calls } = fakeLlm();
    const result = await runSummarizeOnce({
      db: handle.db,
      client,
      now: at('2026-09-10T00:00:00Z'),
      log,
      limit: 2,
    });

    expect(calls).toHaveLength(2);
    expect(result.written).toBe(2);
  });

  it('резюме удаляется вместе с игрой', async () => {
    seed('a', { critic: 2 });
    await runSummarizeOnce({
      db: handle.db,
      client: fakeLlm().client,
      now: at('2026-09-10T00:00:00Z'),
      log,
    });
    expect(allSummaries()).toHaveLength(1);

    handle.sqlite.prepare("DELETE FROM games WHERE slug='a'").run();

    expect(allSummaries()).toEqual([]);
  });
});

describe('таблицы связаны', () => {
  it('reviews и summaries не переживают удаления игры', () => {
    seed('a', { critic: 1, user: 1 });
    handle.sqlite.prepare("DELETE FROM games WHERE slug='a'").run();

    expect(handle.db.select().from(reviews).all()).toEqual([]);
    expect(handle.db.select().from(games).all()).toEqual([]);
  });
});

// ── Отбор отзывов на вход модели ──────────────────────────────────────────

describe('выборка для модели (§4.1)', () => {
  const mk = (id: string, sentiment: Review['sentiment']): Review => ({
    externalId: id,
    kind: 'user',
    text: `текст ${id}`,
    score: 8,
    scoreMax: 10,
    author: null,
    date: null,
    url: null,
    platform: null,
    sentiment,
  });

  it('короткий список отдаётся целиком', () => {
    const list = [mk('a', 'positive'), mk('b', 'negative')];

    expect(selectForSummary(list, 'user')).toEqual(list);
  });

  it('критиков режет по 40 подряд: тональности у них нет', () => {
    const list: Review[] = Array.from({ length: 89 }, (_, i) => ({
      ...mk(`c${i}`, null),
      kind: 'critic',
    }));

    expect(selectForSummary(list, 'critic')).toHaveLength(
      SUMMARY_INPUT_LIMIT.critic,
    );
  });

  it('пользователей режет по 30 и не берёт одни хвалебные', () => {
    // 60 хвалебных против 5 ругательных — если брать первые 30, негатив исчезнет.
    const list = [
      ...Array.from({ length: 60 }, (_, i) => mk(`p${i}`, 'positive')),
      ...Array.from({ length: 5 }, (_, i) => mk(`n${i}`, 'negative')),
    ];

    const picked = selectForSummary(list, 'user');

    expect(picked).toHaveLength(SUMMARY_INPUT_LIMIT.user);
    expect(picked.filter((r) => r.sentiment === 'negative')).toHaveLength(5);
  });

  it('место, не занятое малочисленной тональностью, достаётся остальным', () => {
    const list = [
      ...Array.from({ length: 40 }, (_, i) => mk(`p${i}`, 'positive')),
      ...Array.from({ length: 40 }, (_, i) => mk(`m${i}`, 'mixed')),
      mk('n0', 'negative'),
    ];

    const picked = selectForSummary(list, 'user');

    expect(picked).toHaveLength(SUMMARY_INPUT_LIMIT.user);
    expect(picked.filter((r) => r.sentiment === 'negative')).toHaveLength(1);
    // Остаток поделён между двумя многочисленными, а не отдан одной.
    expect(picked.filter((r) => r.sentiment === 'positive').length).toBeGreaterThan(10);
    expect(picked.filter((r) => r.sentiment === 'mixed').length).toBeGreaterThan(10);
  });

  it('отзывы без тональности не теряются', () => {
    const list = Array.from({ length: 50 }, (_, i) => mk(`u${i}`, null));

    expect(selectForSummary(list, 'user')).toHaveLength(SUMMARY_INPUT_LIMIT.user);
  });
});

describe('воркер шлёт модели выборку, а не всё хранилище', () => {
  it('из 69 отзывов уходит 30', async () => {
    seed('big', { user: 69 });

    const { client, calls } = fakeLlm();
    await runSummarizeOnce({
      db: handle.db,
      client,
      now: at('2026-09-10T00:00:00Z'),
      log,
    });

    expect(calls[0]?.n).toBe(SUMMARY_INPUT_LIMIT.user);
    // А в правиле обновления учитывается полное число.
    expect(allSummaries()[0]?.reviewCountAt).toBe(69);
  });
});
