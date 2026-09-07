import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { env } from '../config/env.js';
import { schema } from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

/** Каталог с SQL-миграциями, сгенерированными `pnpm db:generate`. */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../drizzle');

export interface DbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * Открывает соединение с SQLite. `path` по умолчанию из `DATABASE_PATH`;
 * тесты передают свой путь или `:memory:`.
 */
export function createDb(path: string = env.DATABASE_PATH): DbHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const sqlite = new Database(path);
  // WAL — параллельное чтение HTTP-слоя во время записи воркеров.
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}

/** Накатывает миграции на открытое соединение. */
export function runMigrations(handle: DbHandle): void {
  migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
}
