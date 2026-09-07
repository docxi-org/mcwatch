import { env } from '../config/env.js';
import { componentLogger } from '../config/logger.js';
import { MetacriticClient } from '../clients/metacritic/index.js';
import { createDb, runMigrations } from '../db/index.js';
import { runCrawlOnce } from '../workers/crawler.js';

/**
 * `pnpm crawl --once` — один заход сбора вручную (CLAUDE.md, «Команды»).
 * Периодический запуск появится с планировщиком на G4.
 */

const log = componentLogger('crawl-cli');

if (!process.argv.includes('--once')) {
  process.stderr.write(
    'Использование: pnpm crawl --once\n' +
      'Другого режима пока нет: расписание появится вместе с планировщиком (G4).\n',
  );
  process.exit(2);
}

const handle = createDb();
try {
  runMigrations(handle);
  const result = await runCrawlOnce({ db: handle.db, client: new MetacriticClient() });

  log.info(
    {
      date: result.date,
      target: result.target,
      listed: result.listed,
      saved: result.saved,
      failed: result.failed,
      alreadyProcessedToday: result.alreadyProcessedToday,
      skippedInList: result.skippedInList,
    },
    'сбор завершён',
  );

  if (result.failures.length > 0) {
    log.warn({ failures: result.failures }, 'часть игр не собрана');
  }
  // Ненулевой код только если не сохранилось вообще ничего, а список не был пуст:
  // отдельные неудачи — штатная ситуация, обход их переживает.
  process.exit(result.saved === 0 && result.listed > 0 ? 1 : 0);
} catch (err) {
  log.error({ err, path: env.DATABASE_PATH }, 'заход сбора сорвался');
  process.exit(1);
} finally {
  handle.close();
}
