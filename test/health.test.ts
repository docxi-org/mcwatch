import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';

const app = createApp();

describe('HTTP-скелет', () => {
  it('GET /api/health отвечает 200 и статусом ok', async () => {
    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'mcwatch' });
  });

  it('неизвестный маршрут отдаёт 404 в JSON', async () => {
    const res = await app.request('/api/nope');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
