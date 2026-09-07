import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_OVER,
  COLLAPSE_TO,
  MAX_HITS,
  collapse,
  costText,
  durationMsText,
  numberText,
  searchHits,
} from '../web/src/lib/pipeline.js';

/**
 * Чтение сырья в окне конвейера. Замер по базе: вызов доходит до 56 000
 * знаков, и подать его одной портянкой владелец запретил прямо.
 */

describe('подписи метрик', () => {
  it('длительность читается человеком, а не в миллисекундах', () => {
    expect(durationMsText(1869)).toBe('1.9 с');
    // Настоящий случай из базы: три попытки и четыре с лишним минуты.
    expect(durationMsText(256157)).toBe('4 мин 16 с');
    expect(durationMsText(240)).toBe('240 мс');
  });

  it('стоимость всегда приблизительная: провайдер её не присылает', () => {
    expect(costText(0.00027555)).toBe('≈ $0.00028');
    expect(costText(1.5)).toBe('≈ $1.50');
    expect(costText(0)).toBe('≈ $0');
  });

  it('разряды разделены неразрывным пробелом: число не переносится', () => {
    expect(numberText(42944)).toBe('42 944');
  });

  it('нет числа — прочерк, а не ноль', () => {
    expect(numberText(null)).toBe('—');
    expect(costText(null)).toBe('—');
  });
});

describe('свёртка длинного сырья', () => {
  it('короткое остаётся целым и кнопки не просит', () => {
    const short = 'а'.repeat(100);

    expect(collapse(short, false)).toEqual({
      text: short,
      collapsible: false,
      hiddenChars: 0,
    });
  });

  it('длинное режется, и видно, сколько спрятано', () => {
    const long = 'б'.repeat(5000);

    const cut = collapse(long, false);

    expect(cut.text).toHaveLength(COLLAPSE_TO);
    expect(cut.collapsible).toBe(true);
    expect(cut.hiddenChars).toBe(5000 - COLLAPSE_TO);
  });

  it('раскрытое отдаётся целиком, но кнопку не теряет', () => {
    const long = 'в'.repeat(COLLAPSE_OVER + 1);

    const full = collapse(long, true);

    expect(full.text).toHaveLength(COLLAPSE_OVER + 1);
    expect(full.collapsible).toBe(true);
  });
});

describe('поиск по сырью', () => {
  const text = ['Первая строка', 'вторая про Onimusha', 'третья', 'ещё раз onimusha тут'].join(
    '\n',
  );

  it('находит строки с их номерами', () => {
    expect(searchHits(text, 'Onimusha')).toEqual([
      { num: 2, text: 'вторая про Onimusha' },
      { num: 4, text: 'ещё раз onimusha тут' },
    ]);
  });

  it('регистр не важен: расшифровки приходят как попало', () => {
    expect(searchHits(text, 'ПЕРВАЯ')).toHaveLength(1);
  });

  it('пустой запрос ничего не ищет, а не находит всё', () => {
    expect(searchHits(text, '   ')).toEqual([]);
  });

  it('список обрезается: длиннее его перестают читать', () => {
    const many = Array.from({ length: 200 }, () => 'повтор').join('\n');

    expect(searchHits(many, 'повтор')).toHaveLength(MAX_HITS);
  });
});
