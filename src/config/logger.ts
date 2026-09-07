import { pino } from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'mcwatch' },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
    : {}),
});

/** Логгер, помеченный именем подсистемы: `logger.child({ component })`. */
export function componentLogger(component: string) {
  return logger.child({ component });
}
