import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type DbHandle } from '../src/db/index.js';

/**
 * Проверяет, что миграции создают ровно схему из `docs/ARCHITECTURE.md` §3:
 * все таблицы, их первичные ключи и заявленные уникальные ограничения.
 */

interface TableInfoRow {
  name: string;
  pk: number;
  notnull: number;
}

/** Таблица → колонки первичного ключа в порядке объявления (§3). */
const EXPECTED_TABLES: Record<string, string[]> = {
  games: ['slug'],
  game_platforms: ['game_slug', 'platform'],
  reviews: ['id'],
  summaries: ['game_slug', 'kind'],
  letsplays: ['game_slug'],
  crawl_state: ['date'],
  jobs: ['id'],
  worker_status: ['worker'],
  events_log: ['id'],
  llm_runs: ['id'],
  letsplay_candidates: ['id'],
};

let dir: string;
let handle: DbHandle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcwatch-test-'));
  handle = createDb(join(dir, 'test.db'));
  runMigrations(handle);
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function primaryKeyOf(table: string): string[] {
  const rows = handle.sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as TableInfoRow[];
  return rows
    .filter((r) => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => r.name);
}

describe('миграции', () => {
  it('создают все таблицы схемы и ничего сверх них', () => {
    const rows = handle.sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'
         ORDER BY name`,
      )
      .all() as { name: string }[];

    expect(rows.map((r) => r.name)).toEqual(Object.keys(EXPECTED_TABLES).sort());
  });

  it.each(Object.entries(EXPECTED_TABLES))(
    'таблица %s имеет первичный ключ %j',
    (table, pk) => {
      expect(primaryKeyOf(table)).toEqual(pk);
    },
  );

  it('дедуплицирует отзывы по (game_slug, kind, external_id)', () => {
    handle.sqlite
      .prepare(`INSERT INTO games (slug, title) VALUES ('g', 'G')`)
      .run();
    const insert = handle.sqlite.prepare(
      `INSERT INTO reviews (game_slug, kind, external_id, score_max, text)
       VALUES ('g', 'critic', 'r1', 100, 'txt')`,
    );

    insert.run();
    expect(() => {
      insert.run();
    }).toThrow(/UNIQUE/i);
  });

  it('включает внешние ключи: отзыв без игры не вставляется', () => {
    expect(() => {
      handle.sqlite
        .prepare(
          `INSERT INTO reviews (game_slug, kind, external_id, score_max, text)
           VALUES ('missing', 'user', 'r9', 10, 'txt')`,
        )
        .run();
    }).toThrow(/FOREIGN KEY/i);
  });

  it('идемпотентны: повторный прогон не падает', () => {
    expect(() => {
      runMigrations(handle);
    }).not.toThrow();
  });
});
