import { z } from 'zod';

/**
 * Единственное место чтения `process.env`. Секреты — только отсюда,
 * значения по умолчанию рассчитаны на локальный запуск без `.env`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  /** Путь к файлу SQLite. `:memory:` допустим для тестов. */
  DATABASE_PATH: z.string().min(1).default('./data/mcwatch.db'),
  /** Ключ OpenRouter. На шаге G1 не используется — потому optional. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** Контакт в User-Agent при обращении к Metacritic (CLAUDE.md, правила кода). */
  CONTACT_EMAIL: z.email().default('mcwatch@example.com'),
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Некорректные переменные окружения:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();
