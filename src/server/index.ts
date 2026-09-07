import { serve } from '@hono/node-server';
import { env } from '../config/env.js';
import { componentLogger } from '../config/logger.js';
import { createApp } from './app.js';

const log = componentLogger('server');

const server = serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, env: env.NODE_ENV }, 'mcwatch слушает');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'останов');
    server.close(() => {
      process.exit(0);
    });
  });
}
