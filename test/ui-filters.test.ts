import { describe, expect, it } from 'vitest';
import {
  filtersFromQuery,
  filtersKey,
  filtersToQuery,
  isDefaultFilters,
  sortNote,
} from '../web/src/lib/listFilters.js';

/**
 * Отбор живёт в адресе: он должен переживать перезагрузку и годиться для
 * ссылки. Проверяется разбор чужого адреса и обратная сборка.
 */

describe('разбор адреса', () => {
  it('берёт платформу, запрос и сортировку', () => {
    expect(
      filtersFromQuery({ platform: 'PlayStation 5', q: 'onimusha', sort: 'metascore' }),
    ).toEqual({
      platform: 'PlayStation 5',
      q: 'onimusha',
      sort: 'metascore',
      letsplay: false,
      trailer: false,
    });
  });

  it('пустой адрес — умолчания', () => {
    expect(filtersFromQuery({})).toEqual({
      platform: null,
      q: null,
      sort: 'date',
      letsplay: false,
      trailer: false,
    });
  });

  it('дополнительные фильтры включаются наличием параметра', () => {
    expect(filtersFromQuery({ letsplay: '1' })).toMatchObject({
      letsplay: true,
      trailer: false,
    });
    expect(filtersFromQuery({ letsplay: '1', trailer: '1' })).toMatchObject({
      letsplay: true,
      trailer: true,
    });
  });

  it('негодная сортировка не роняет экран, а заменяется умолчанием', () => {
    // 400 пользователь может получить, только вписав мусор руками (§ошибки).
    expect(filtersFromQuery({ sort: 'по-вкусу' }).sort).toBe('date');
  });

  it('пустые и пробельные значения — это отсутствие значения, не пустая строка', () => {
    expect(filtersFromQuery({ q: '   ', platform: '' })).toMatchObject({
      platform: null,
      q: null,
      sort: 'date',
    });
  });

  it('повтор параметра в адресе берётся первым', () => {
    expect(filtersFromQuery({ platform: ['PC', 'Xbox Series X'] }).platform).toBe('PC');
  });
});

describe('сборка адреса', () => {
  it('умолчания в адрес не пишутся: / и /?sort=date — одна ссылка', () => {
    expect(
      filtersToQuery({ platform: null, q: null, sort: 'date', letsplay: false, trailer: false }),
    ).toEqual({});
  });

  it('непустой отбор попадает в адрес целиком', () => {
    expect(
      filtersToQuery({ platform: 'PC', q: 'neon', sort: 'title', letsplay: true, trailer: true }),
    ).toEqual({
      platform: 'PC',
      q: 'neon',
      sort: 'title',
      letsplay: '1',
      trailer: '1',
    });
  });

  it('адрес и разбор обратимы', () => {
    const filters = {
      platform: 'Nintendo Switch 2',
      q: 'zelda',
      sort: 'userscore',
      letsplay: true,
      trailer: false,
    } as const;
    expect(filtersFromQuery(filtersToQuery(filters))).toEqual(filters);
  });
});

describe('служебное', () => {
  it('ключ отбора различает разные отборы и совпадает у одинаковых', () => {
    const base = { platform: 'PC', q: null, sort: 'date', letsplay: false, trailer: false } as const;
    expect(filtersKey(base)).toBe(filtersKey({ ...base }));
    expect(filtersKey(base)).not.toBe(filtersKey({ ...base, platform: null, q: 'PC' }));
    // Дополнительные фильтры обязаны попадать в ключ: иначе при возврате из
    // карточки восстановился бы список от другого отбора.
    expect(filtersKey(base)).not.toBe(filtersKey({ ...base, letsplay: true }));
    expect(filtersKey({ ...base, letsplay: true })).not.toBe(
      filtersKey({ ...base, trailer: true }),
    );
  });

  it('умолчания опознаются: от них зависит, что показать на пустом списке', () => {
    const base = { platform: null, q: null, sort: 'date', letsplay: false, trailer: false } as const;
    expect(isDefaultFilters(base)).toBe(true);
    expect(isDefaultFilters({ ...base, sort: 'title' })).toBe(false);
    expect(isDefaultFilters({ ...base, letsplay: true })).toBe(false);
    expect(isDefaultFilters({ ...base, trailer: true })).toBe(false);
  });

  it('подпись сортировки — дословно из макета', () => {
    expect(sortNote('date')).toBe('сортировка: по дате');
    expect(sortNote('metascore')).toBe('сортировка: по метаскору');
  });
});
