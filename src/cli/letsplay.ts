import { componentLogger } from '../config/logger.js';
import { MissingApiKeyError, OpenRouterClient } from '../clients/openrouter.js';
import { YouTubeClient } from '../clients/youtube.js';
import { createDb, runMigrations } from '../db/index.js';
import { letsplayStats } from '../db/repo/letsplays.js';
import { runLetsplayOnce } from '../workers/letsplay.js';

/** `pnpm letsplay --once [--limit N]` — один прогон подбора летсплеев. */

const log = componentLogger('letsplay-cli');
const argv = process.argv.slice(2);

if (!argv.includes('--once')) {
  process.stderr.write('Использование: pnpm letsplay --once [--limit N]\n');
  process.exit(2);
}

const at = argv.indexOf('--limit');
const limit = at === -1 ? undefined : Number(argv[at + 1]);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  process.stderr.write('--limit ожидает целое число ≥ 1\n');
  process.exit(2);
}

const handle = createDb();
try {
  runMigrations(handle);
  const result = await runLetsplayOnce({
    db: handle.db,
    youtube: new YouTubeClient(),
    llm: new OpenRouterClient(),
    ...(limit === undefined ? {} : { limit }),
  });

  log.info(
    {
      pending: result.pending,
      done: result.done,
      noVideo: result.noVideo,
      noTranscript: result.noTranscript,
      failed: result.failed,
      статусы: letsplayStats(handle.db),
    },
    'летсплеи готовы',
  );

  // Отвергнутое печатается всегда: потеря обязана быть видимой.
  for (const [slug, list] of Object.entries(result.rejected)) {
    log.info({ slug, отвергнуто: list }, 'кандидаты, которые не подошли');
  }
  process.exit(0);
} catch (err) {
  if (err instanceof MissingApiKeyError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  log.error({ err }, 'прогон летсплеев сорвался');
  process.exit(1);
} finally {
  handle.close();
}
