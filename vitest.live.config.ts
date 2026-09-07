import { defineConfig } from 'vitest/config';

// Сетевые тесты: запускаются вручную (`pnpm test:live`), в `pnpm check` не входят.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
