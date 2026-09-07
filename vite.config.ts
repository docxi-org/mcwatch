import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * Фронт живёт в `web/`, собирается в `web/dist` и отдаётся тем же процессом,
 * что и API (`src/server/index.ts`). Поэтому запросы идут на относительные
 * пути, а в разработке проксируются на бэкенд.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Обложки грузятся с чужого домена, свои ассеты — только шрифты и код.
    assetsInlineLimit: 2048,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
