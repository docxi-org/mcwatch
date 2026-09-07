import type { CallMeta, LlmCall } from '../src/clients/openrouter.js';

/**
 * Обёртка для подделок клиента: методы возвращают не только ответ, но и
 * метрики вызова. Числа здесь заведомо ненастоящие — тесты проверяют не их,
 * а то, что запись о вызове вообще появляется.
 */
export const FAKE_META: CallMeta = {
  model: 'test-model',
  attempts: 1,
  durationMs: 12,
  promptTokens: 100,
  completionTokens: 20,
  costUsd: 0.0001,
  system: 'системная часть',
  prompt: 'сырьё',
};

export function asCall<T>(value: T, over: Partial<CallMeta> = {}): LlmCall<T> {
  return { value, meta: { ...FAKE_META, ...over } };
}
