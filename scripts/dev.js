import { spawn } from 'node:child_process';

/**
 * Разработка идёт в двух процессах: бэкенд на 3000 и vite на 5173, который
 * проксирует `/api` на бэкенд. В продакшене процесс один — статику отдаёт
 * тот же сервер (CLAUDE.md).
 */
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
