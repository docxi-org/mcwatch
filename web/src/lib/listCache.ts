import type { GameListItemDto } from '../api/types.js';

/**
 * Возврат из карточки не должен стоить пользователю ни прокрутки, ни заново
 * подгруженных страниц (`ui/Спека.dc.html`, «Список: адрес и подгрузка»).
 * Живёт на время сессии вкладки — переживать перезагрузку тут нечему.
 */
export interface ListSnapshot {
  key: string;
  items: GameListItemDto[];
  total: number;
  page: number;
  scrollY: number;
}

let snapshot: ListSnapshot | null = null;

export function saveList(next: ListSnapshot): void {
  snapshot = next;
}

/** Отдаёт снимок только тому же отбору: чужой сбил бы пользователя с толку. */
export function takeList(key: string): ListSnapshot | null {
  if (!snapshot || snapshot.key !== key) return null;
  const found = snapshot;
  snapshot = null;
  return found;
}

export function dropList(): void {
  snapshot = null;
}
