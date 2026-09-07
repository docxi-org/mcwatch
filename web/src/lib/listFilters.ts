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
  /** Только игры с готовым заключением о летсплее. */
  letsplay: boolean;
  /** Только игры, у которых есть трейлер. */
  trailer: boolean;
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

/** Признак включён, если параметр вообще есть: `?letsplay=1`. */
function flag(value: RawQueryValue): boolean {
  return first(value) !== null;
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
    letsplay: flag(query['letsplay']),
    trailer: flag(query['trailer']),
  };
}

export function filtersToQuery(filters: ListFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.platform) query['platform'] = filters.platform;
  if (filters.q) query['q'] = filters.q;
  if (filters.sort !== DEFAULT_SORT) query['sort'] = filters.sort;
  if (filters.letsplay) query['letsplay'] = '1';
  if (filters.trailer) query['trailer'] = '1';
  return query;
}

/**
 * Ключ отбора для кэша списка. Собирается через `JSON.stringify`, а не
 * склейкой через разделитель: любой разделитель рано или поздно встретится
 * в поисковом запросе, и два разных отбора сойдутся в один ключ.
 */
export function filtersKey(filters: ListFilters): string {
  return JSON.stringify([
    filters.platform,
    filters.q,
    filters.sort,
    filters.letsplay,
    filters.trailer,
  ]);
}

export function isDefaultFilters(filters: ListFilters): boolean {
  return (
    filters.platform === null &&
    filters.q === null &&
    filters.sort === DEFAULT_SORT &&
    !filters.letsplay &&
    !filters.trailer
  );
}

/** Подпись справа над сеткой — дословно из макета: «сортировка: по дате». */
export function sortNote(sort: SortKey): string {
  const label = SORTS.find((s) => s.key === sort)?.label;
  return label ? `сортировка: ${label}` : '';
}
