import { componentLogger } from '../config/logger.js';
import { MissingApiKeyError, OpenRouterClient } from '../clients/openrouter.js';
import { createDb, runMigrations } from '../db/index.js';
import { loadSimilarityPool } from '../db/repo/embeddings.js';
import { games } from '../db/schema.js';
import { runEmbedOnce } from '../workers/embedder.js';
import { findSimilar } from '../workers/similarity.js';

/**
 * `pnpm embed --once` — один прогон эмбеддингов. С `--show N` дополнительно
 * печатает похожие игры для N случайных карточек: их качество проверяется
 * глазами, автоматически его не измерить.
 */

const log = componentLogger('embed-cli');

const argv = process.argv.slice(2);
if (!argv.includes('--once')) {
  process.stderr.write('Использование: pnpm embed --once [--show N]\n');
  process.exit(2);
}

const showAt = argv.indexOf('--show');
const show = showAt === -1 ? 0 : Number(argv[showAt + 1] ?? 5);

const handle = createDb();
try {
  runMigrations(handle);
  const result = await runEmbedOnce({
    db: handle.db,
    client: new OpenRouterClient(),
  });

  log.info(
    { pending: result.pending, written: result.written, failed: result.failed },
    'эмбеддинги готовы',
  );
  if (result.failures.length > 0) {
    log.warn({ failures: result.failures }, 'часть пачек не посчитана');
  }

  if (show > 0) {
    const pool = loadSimilarityPool(handle.db);
    const titles = new Map(
      handle.db
        .select({ slug: games.slug, title: games.title })
        .from(games)
        .all()
        .map((r) => [r.slug, r.title] as const),
    );
    process.stdout.write(`\nПохожие игры (пул: ${pool.length}):\n`);
    for (const target of pool.slice(0, show)) {
      const similar = findSimilar(target, pool);
      process.stdout.write(`\n  ${titles.get(target.slug) ?? target.slug}\n`);
      if (similar.length === 0) process.stdout.write('    — похожих не нашлось\n');
      for (const s of similar) {
        process.stdout.write(
          `    ${s.score.toFixed(3)}  ${titles.get(s.slug) ?? s.slug}\n`,
        );
      }
    }
  }
  process.exit(0);
} catch (err) {
  if (err instanceof MissingApiKeyError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  log.error({ err }, 'прогон эмбеддингов сорвался');
  process.exit(1);
} finally {
  handle.close();
}
