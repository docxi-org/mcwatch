import { spawn } from 'node:child_process';

/**
 * Разработка идёт в двух процессах: бэкенд на `PORT` (3000 по умолчанию) и
 * vite на `WEB_PORT` (5173), который проксирует `/api` на бэкенд. Оба берут
 * порты из одного окружения, поэтому `PORT=3100 pnpm dev` переносит обе
 * стороны разом. В продакшене процесс один — статику отдаёт тот же сервер
 * (CLAUDE.md).
 */
const api = process.env.PORT ?? '3000';
const web = process.env.WEB_PORT ?? '5173';
console.log(`API http://127.0.0.1:${api}  ·  фронт http://127.0.0.1:${web}`);
const tasks = [
  ['сервер', 'pnpm', ['exec', 'tsx', 'watch', 'src/server/index.ts']],
  ['фронт', 'pnpm', ['exec', 'vite']],
];

const children = tasks.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    console.log(`[${name}] завершился с кодом ${code}`);
    stopAll();
    process.exit(code ?? 0);
  });
  return child;
});

function stopAll() {
  for (const child of children) if (!child.killed) child.kill();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}
