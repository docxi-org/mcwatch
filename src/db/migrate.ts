import { env } from '../config/env.js';
import { componentLogger } from '../config/logger.js';
import { createDb, runMigrations } from './index.js';

const log = componentLogger('migrate');

const handle = createDb();
try {
  runMigrations(handle);
  log.info({ path: env.DATABASE_PATH }, 'миграции накачены');
} finally {
  handle.close();
}
