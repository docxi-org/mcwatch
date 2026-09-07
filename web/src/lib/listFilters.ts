import type { SortKey } from '../api/types.js';

/**
 * Отбор живёт в адресной строке: он должен переживать перезагрузку и годиться
 * для ссылки (`docs/UI-BRIEF.md` §3.1). Значения по умолчанию в адрес не
 * пишутся — иначе `/` и `/?sort=date` были бы разными ссылками на одно.
 */

export const DEFAULT_SORT: SortKey = 'date';
export const PAGE_SIZE = 24;

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'date', label: 'по дате' },
  { key: 'metascore', label: 'по метаскору' },
  { key: 'userscore', label: 'по игрокам' },
  { key: 'title', label: 'по названию' },
];

export interface ListFilters {
  platform: string | null;
  q: string | null;
  sort: SortKey;
}

/** Сырое значение из адреса: vue-router отдаёт строку, массив либо ничего. */
type RawQueryValue = string | null | undefined | (string | null)[];

function first(value: RawQueryValue): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSortKey(value: string | null): value is SortKey {
  return value === 'metascore' || value === 'userscore' || value === 'date' || value === 'title';
}

/**
 * Мусор в адресе не должен показывать экран ошибки: 400 пользователь может
 * получить, только вписав его руками. Негодные значения молча заменяются на
 * умолчания, и список показывается как обычно (`ui/Спека.dc.html`, ошибки).
 */
export function filtersFromQuery(query: Record<string, RawQueryValue>): ListFilters {
  const sort = first(query['sort']);
  return {
    platform: first(query['platform']),
    q: first(query['q']),
    sort: isSortKey(sort) ? sort : DEFAULT_SORT,
  };
}

export function filtersToQuery(filters: ListFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.platform) query['platform'] = filters.platform;
  if (filters.q) query['q'] = filters.q;
  if (filters.sort !== DEFAULT_SORT) query['sort'] = filters.sort;
  return query;
}

export function filtersKey(filters: ListFilters): string {
  return `${filters.platform ?? ''}\u0000${filters.q ?? ''}\u0000${filters.sort}`;
}

export function isDefaultFilters(filters: ListFilters): boolean {
  return filters.platform === null && filters.q === null && filters.sort === DEFAULT_SORT;
}

/** Подпись справа над сеткой — дословно из макета: «сортировка: по дате». */
export function sortNote(sort: SortKey): string {
  const label = SORTS.find((s) => s.key === sort)?.label;
  return label ? `сортировка: ${label}` : '';
}
