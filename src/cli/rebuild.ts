import { sql } from 'drizzle-orm';
import { MissingApiKeyError, OpenRouterClient } from '../clients/openrouter.js';
import { YouTubeClient } from '../clients/youtube.js';
import { componentLogger } from '../config/logger.js';
import { createDb, runMigrations } from '../db/index.js';
import { games, letsplayCandidates, letsplays, llmRuns, summaries } from '../db/schema.js';
import { runEmbedOnce } from '../workers/embedder.js';
import { runLetsplayOnce } from '../workers/letsplay.js';
import { runSummarizeOnce } from '../workers/summarizer.js';

/**
 * `pnpm rebuild --yes` — переобработка производной части базы.
 *
 * Нужна была один раз: записи о вызовах модели появились позже самих вызовов,
 * и без переобработки карточка конвейера у собранных игр была бы пустой
 * (решение владельца 07.09.2026, `docs/ARCHITECTURE.md` §10).
 *
 * Игры и отзывы НЕ трогаются: они собраны с Metacritic, и тянуть их заново
 * значило бы зря беспокоить источник. Чистится только то, что произведено
 * моделью: резюме, векторы, летсплеи и журнал вызовов.
 */

const log = componentLogger('rebuild');

const argv = process.argv.slice(2);
if (!argv.includes('--yes')) {
  process.stderr.write(
    'Использование: pnpm rebuild --yes\n' +
      'Удаляет резюме, векторы, летсплеи и журнал вызовов, затем считает их заново.\n' +
      'Игры и отзывы остаются на месте. Это платные вызовы модели.\n',
  );
  process.exit(2);
}

const handle = createDb();
try {
  runMigrations(handle);

  const before = {
    summaries: handle.sqlite.prepare('SELECT count(*) n FROM summaries').get() as { n: number },
    letsplays: handle.sqlite.prepare('SELECT count(*) n FROM letsplays').get() as { n: number },
    runs: handle.sqlite.prepare('SELECT count(*) n FROM llm_runs').get() as { n: number },
  };

  handle.db.delete(llmRuns).run();
  handle.db.delete(letsplayCandidates).run();
  handle.db.delete(letsplays).run();
  handle.db.delete(summaries).run();
  // Обнулять вектор — единственный способ заставить эмбеддер посчитать заново:
  // он берёт игры, у которых вектора нет.
  handle.db.update(games).set({ embedding: sql`NULL` }).run();

  log.info(
    {
      удалено: {
        резюме: before.summaries.n,
        летсплеи: before.letsplays.n,
        записи_о_вызовах: before.runs.n,
      },
    },
    'производные данные очищены',
  );

  const client = new OpenRouterClient();
  const youtube = new YouTubeClient();

  const summary = await runSummarizeOnce({ db: handle.db, client, log });
  log.info({ summary }, 'резюме пересчитаны');

  const embed = await runEmbedOnce({ db: handle.db, client, log });
  log.info({ embed }, 'векторы пересчитаны');

  const letsplay = await runLetsplayOnce({ db: handle.db, youtube, llm: client, log, limit: 1000 });
  log.info({ letsplay }, 'летсплеи пересчитаны');

  const totals = handle.sqlite
    .prepare(
      `SELECT count(*) calls,
              coalesce(sum(prompt_tokens), 0) prompt_tokens,
              coalesce(sum(completion_tokens), 0) completion_tokens,
              coalesce(sum(cost_usd), 0) cost_usd
       FROM llm_runs`,
    )
    .get();
  log.info({ totals }, 'переобработка закончена');
} catch (err) {
  if (err instanceof MissingApiKeyError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  throw err;
} finally {
  handle.close();
}
