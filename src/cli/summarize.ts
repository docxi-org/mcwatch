import { componentLogger } from '../config/logger.js';
import { MissingApiKeyError, OpenRouterClient } from '../clients/openrouter.js';
import { createDb, runMigrations } from '../db/index.js';
import { runSummarizeOnce } from '../workers/summarizer.js';

/**
 * `pnpm summarize --once` — один прогон резюме вручную. Сведение сбора и
 * резюме в один часовой цикл появится с планировщиком на G4.
 */

const log = componentLogger('summarize-cli');

const argv = process.argv.slice(2);
if (!argv.includes('--once')) {
  process.stderr.write(
    'Использование: pnpm summarize --once [--limit N]\n' +
      'Расписание появится вместе с планировщиком (G4).\n',
  );
  process.exit(2);
}

const limitArg = argv.indexOf('--limit');
const limit = limitArg === -1 ? undefined : Number(argv[limitArg + 1]);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  process.stderr.write('--limit ожидает целое число ≥ 1\n');
  process.exit(2);
}

const handle = createDb();
try {
  runMigrations(handle);
  const result = await runSummarizeOnce({
    db: handle.db,
    client: new OpenRouterClient(),
    ...(limit === undefined ? {} : { limit }),
  });

  log.info(
    {
      candidates: result.candidates,
      written: result.written,
      upToDate: result.upToDate,
      failed: result.failed,
      reasons: result.reasons,
    },
    'резюме готовы',
  );
  if (result.failures.length > 0) {
    log.warn({ failures: result.failures }, 'часть резюме не сделана');
  }
  process.exit(0);
} catch (err) {
  if (err instanceof MissingApiKeyError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  log.error({ err }, 'прогон резюме сорвался');
  process.exit(1);
} finally {
  handle.close();
}
