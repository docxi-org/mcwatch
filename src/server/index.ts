import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { env } from '../config/env.js';
import { componentLogger } from '../config/logger.js';
import { SERVICE_NAME } from '../config/service.js';
import { createDb, runMigrations } from '../db/index.js';
import { Monitor } from '../workers/monitor.js';
import { createScheduler } from '../workers/pipeline.js';
import { createApp } from './app.js';

const log = componentLogger('server');

const handle = createDb();
runMigrations(handle);

const monitor = new Monitor(handle.db);

const scheduler = env.SCHEDULER_ENABLED
  ? createScheduler({
      db: handle.db,
      intervalMs: env.SCHEDULER_INTERVAL_MIN * 60 * 1000,
      reporter: monitor,
    })
  : null;

const app = createApp({ db: handle.db, monitor, scheduler });

/**
 * Собранный фронт отдаётся тем же процессом (CLAUDE.md). Пока его нет —
 * маршруты не подключаются, и API работает как работал.
 */
const webDist = resolve(env.WEB_DIST);
if (existsSync(webDist)) {
  app.use('/*', serveStatic({ root: env.WEB_DIST }));
  // Клиентский роутинг: неизвестный путь — не 404, а точка входа приложения.
  app.get('*', serveStatic({ path: `${env.WEB_DIST}/index.html` }));
  log.info({ webDist }, 'фронт подключён');
} else {
  log.info({ webDist }, 'сборки фронта нет, отдаётся только API');
}

if (scheduler) scheduler.start();
else log.warn('планировщик выключен переменной SCHEDULER_ENABLED');

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, env: env.NODE_ENV }, `${SERVICE_NAME} слушает`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'останов');
    scheduler?.stop();
    server.close(() => {
      handle.close();
      process.exit(0);
    });
  });
}
