import { describe, expect, it } from 'vitest';
import { scoreView, tierOf } from '../web/src/lib/score.js';

/**
 * Две шкалы оценок — главная предметная тонкость интерфейса. Проверяется
 * именно то, что легко перепутать глазами: пороги, ноль и отсутствие оценки.
 */

describe('градация', () => {
  it('пороги одни и те же по долям шкалы, а не по числам', () => {
    // 0.75 и 0.5 от шкалы: 75 и 7.5 обязаны попасть в одну зону.
    expect(tierOf('critic', 75)).toBe('good');
    expect(tierOf('user', 7.5)).toBe('good');

    expect(tierOf('critic', 74)).toBe('mixed');
    expect(tierOf('user', 7.4)).toBe('mixed');

    expect(tierOf('critic', 50)).toBe('mixed');
    expect(tierOf('user', 5)).toBe('mixed');

    expect(tierOf('critic', 49)).toBe('bad');
    expect(tierOf('user', 4.9)).toBe('bad');
  });

  it('ноль — настоящая оценка и красится в «плохо»', () => {
    expect(tierOf('critic', 0)).toBe('bad');
    expect(tierOf('user', 0)).toBe('bad');
  });

  it('отсутствие оценки — отдельная зона, не «плохо»', () => {
    expect(tierOf('critic', null)).toBe('none');
    expect(tierOf('user', null)).toBe('none');
  });
});

describe('показ числа', () => {
  it('метаскор целый со своей шкалой', () => {
    expect(scoreView('critic', 89)).toMatchObject({
      present: true,
      value: '89',
      suffix: '/100',
      fillPercent: 89,
    });
  });

  it('оценка игроков всегда с одним знаком: 8 и 8.0 — одна шкала', () => {
    expect(scoreView('user', 8)).toMatchObject({ value: '8.0', suffix: '/10', fillPercent: 80 });
    expect(scoreView('user', 9.3).value).toBe('9.3');
  });

  it('ноль показывается числом, а не прочерком', () => {
    expect(scoreView('user', 0)).toMatchObject({
      present: true,
      value: '0.0',
      tier: 'bad',
      fillPercent: 0,
    });
  });

  it('null — прочерк без суффикса: рисовать ноль тут нельзя', () => {
    expect(scoreView('critic', null)).toMatchObject({
      present: false,
      value: '—',
      suffix: '',
      tier: 'none',
      fillPercent: 0,
    });
  });

  it('подписи шкал не смешиваются', () => {
    expect(scoreView('critic', 70).scaleLabel).toBe('КРИТИКИ 0–100');
    expect(scoreView('user', 7).scaleLabel).toBe('ИГРОКИ 0–10');
  });

  it('заполнение полосы не выходит за края', () => {
    expect(scoreView('critic', 100).fillPercent).toBe(100);
    expect(scoreView('user', 10).fillPercent).toBe(100);
  });
});
