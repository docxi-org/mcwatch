import { Hono } from 'hono';
import { createCatalogRoutes } from '../api/games.js';
import { componentLogger } from '../config/logger.js';
import { SERVICE_NAME } from '../config/service.js';
import type { Db } from '../db/index.js';

const log = componentLogger('http');

/**
 * Собирает Hono-приложение. Экспортируется отдельно от запуска слушателя,
 * чтобы тесты били по нему через `app.request()` без открытия порта.
 */
export function createApp(db?: Db): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    log.error({ err, path: c.req.path }, 'необработанная ошибка запроса');
    return c.json({ error: 'internal_error' }, 500);
  });

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      service: SERVICE_NAME,
      uptimeS: Math.round(process.uptime()),
    }),
  );

  // Каталог подключается только когда есть БД: `/api/health` должен отвечать
  // и без неё, иначе проверка живости зависела бы от состояния хранилища.
  if (db) app.route('/api', createCatalogRoutes(db));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  return app;
}
