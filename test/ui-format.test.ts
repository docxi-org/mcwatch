import { describe, expect, it } from 'vitest';
import {
  agoText,
  checkedCounterText,
  countText,
  dateText,
  durationText,
  hoursSince,
  plural,
  stampHuman,
  stampText,
  viewsText,
} from '../web/src/lib/format.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

describe('даты', () => {
  it('дата релиза по-русски', () => {
    expect(dateText('2026-09-04')).toBe('4 сентября 2026');
  });

  it('пустая дата называется пустой, а не подставляется', () => {
    expect(dateText(null)).toBe('дата неизвестна');
  });

  it('нераспознанная дата отдаётся как есть, а не превращается в мусор', () => {
    expect(dateText('скоро')).toBe('скоро');
  });

  it('отметка обхода — по часам UTC', () => {
    expect(stampText('2026-09-07T13:05:00.000Z')).toBe('07.09.2026 13:05');
    expect(stampText(null)).toBe('ещё не было');
  });

  it('в полосе устаревшего обхода время читается словами — как в макете', () => {
    expect(stampHuman('2026-09-06T04:00:00.000Z')).toBe('6 сентября в 04:00');
    expect(stampHuman(null)).toBe('ещё не было');
  });
});

describe('склонения', () => {
  it('русские формы по числу', () => {
    expect(plural(1, 'отзыв', 'отзыва', 'отзывов')).toBe('отзыв');
    expect(plural(3, 'отзыв', 'отзыва', 'отзывов')).toBe('отзыва');
    expect(plural(5, 'отзыв', 'отзыва', 'отзывов')).toBe('отзывов');
    // Одиннадцать-четырнадцать — исключение, на нём ломается наивная формула.
    expect(plural(11, 'отзыв', 'отзыва', 'отзывов')).toBe('отзывов');
    expect(plural(21, 'отзыв', 'отзыва', 'отзывов')).toBe('отзыв');
    expect(plural(112, 'отзыв', 'отзыва', 'отзывов')).toBe('отзывов');
  });

  it('счёт склеивается с числом', () => {
    expect(countText(89, 'отзыв', 'отзыва', 'отзывов')).toBe('89 отзывов');
  });
});

describe('давность', () => {
  it('считается по переданным часам, а не по часам браузера', () => {
    expect(agoText('2026-09-07T11:58:00.000Z', NOW)).toBe('2 минуты назад');
    expect(agoText('2026-09-07T11:59:30.000Z', NOW)).toBe('30 с назад');
    // Первые пять секунд — «только что»: секундный отсчёт там мельтешит.
    expect(agoText('2026-09-07T11:59:58.000Z', NOW)).toBe('только что');
    expect(agoText('2026-09-07T09:00:00.000Z', NOW)).toBe('3 часа назад');
    expect(agoText('2026-09-05T12:00:00.000Z', NOW)).toBe('2 дня назад');
  });

  it('воркер, который не работал ни разу, так и говорит', () => {
    expect(agoText(null, NOW)).toBe('ещё не работал');
  });

  it('часы с последнего обхода: по ним решается, устарел ли каталог', () => {
    expect(hoursSince('2026-09-06T12:00:00.000Z', NOW)).toBe(24);
    expect(hoursSince(null, NOW)).toBeNull();
  });
});

describe('летсплей', () => {
  it('просмотры округляются: точное число ничего не решает', () => {
    expect(viewsText(1_250_000)).toBe('1.3 млн просмотров');
    expect(viewsText(12_400)).toBe('12 тыс. просмотров');
    expect(viewsText(3)).toBe('3 просмотра');
  });

  it('неизвестные просмотры не превращаются в ноль', () => {
    expect(viewsText(null)).toBe('просмотры неизвестны');
  });

  it('длительность в часах и минутах', () => {
    expect(durationText(3725)).toBe('1:02:05');
    expect(durationText(605)).toBe('10:05');
    expect(durationText(null)).toBe('длительность неизвестна');
  });
});

describe('счётчик «проверено»', () => {
  it('прогоны до появления колонки показывают прочерк, а не ноль', () => {
    // На боевом было «проверено 0 · обработано 84» — видимое противоречие.
    expect(checkedCounterText(0, 84)).toBe('—');
  });

  it('настоящий ноль у воркера, который ещё не работал, остаётся нулём', () => {
    expect(checkedCounterText(0, 0)).toBe('0');
  });

  it('обычное число показывается как есть', () => {
    expect(checkedCounterText(33, 0)).toBe('33');
    expect(checkedCounterText(5, 5)).toBe('5');
  });
});
