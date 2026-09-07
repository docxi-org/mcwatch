import { describe, expect, it } from 'vitest';
import { MIN_LOADING_MS, remainingMs } from '../web/src/lib/pacing.js';

/**
 * Локальный API отвечает за 2 мс, и заглушки исчезали раньше, чем их видно.
 * Минимальная длительность состояния загрузки — не украшение, а условие
 * того, что признак работы вообще существует для глаза.
 */

describe('минимальная длительность загрузки', () => {
  const START = 1_000_000;

  it('мгновенный ответ добирает недостающее время', () => {
    // 2 мс — реальный замер по локальной базе.
    expect(remainingMs(START, START + 2)).toBe(MIN_LOADING_MS - 2);
  });

  it('медленный ответ не задерживается ни на миллисекунду', () => {
    expect(remainingMs(START, START + MIN_LOADING_MS)).toBe(0);
    expect(remainingMs(START, START + 5000)).toBe(0);
  });

  it('часы, шагнувшие назад, не превращаются в бесконечное ожидание', () => {
    expect(remainingMs(START, START - 10_000)).toBe(MIN_LOADING_MS);
  });

  it('порог задаётся снаружи: это параметр, а не магия внутри', () => {
    expect(remainingMs(START, START + 100, 250)).toBe(150);
  });
});
