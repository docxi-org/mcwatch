/**
 * Нормализованные формы Metacritic. Клиент отдаёт наружу только их: сырой JSON
 * источника за границу модуля не выходит. Отсутствие данных — всегда `null`
 * (CLAUDE.md, «Правила кода»).
 */

export type ReviewKind = 'critic' | 'user';

/**
 * Словарь схемы (`db/schema.ts`), а не источника: Metacritic называет
 * нейтральную тональность `neutral`, у нас она `mixed`. Перевод — в `parse.ts`.
 */
export type ReviewSentiment = 'positive' | 'mixed' | 'negative';

/** Элемент списка (finder). Разработчика, платформ и видео в списке нет (§6). */
export interface ListedGame {
  slug: string;
  title: string;
  releaseDate: string | null;
  coverUrl: string | null;
  /** Metascore 0–100 по сводке списка. */
  metascore: number | null;
  genres: string[];
}

export interface GamePlatform {
  /** Человекочитаемое имя: «PlayStation 5». */
  name: string;
  /** Слаг для маршрутов отзывов: `playstation-5`. */
  slug: string | null;
  /** Metascore 0–100. */
  metascore: number | null;
  criticCount: number | null;
  isLead: boolean;
}

export interface GameCard {
  slug: string;
  title: string;
  description: string | null;
  developer: string | null;
  publisher: string | null;
  genres: string[];
  releaseDate: string | null;
  esrb: string | null;
  coverUrl: string | null;
  /** Ссылка на страницу трейлера у jwplayer; null — трейлера нет. */
  videoUrl: string | null;
  platforms: GamePlatform[];
}

/** Сводка оценок. `max` различает шкалы: 100 у критиков, 10 у пользователей. */
export interface ScoreStats {
  score: number | null;
  max: number;
  /** Число оценок, а не текстов: у него своя семантика, см. §6. */
  reviewCount: number | null;
}

export interface Review {
  /** У пользователей — UUID источника; у критиков выводится, см. `parse.ts`. */
  externalId: string;
  kind: ReviewKind;
  text: string;
  score: number | null;
  scoreMax: number;
  author: string | null;
  date: string | null;
  url: string | null;
  platform: string | null;
  /**
   * Заполняется, когда отзыв получен запросом с конкретной тональностью:
   * отдельным полем источник её не отдаёт (§6), но при `filterBySentiment`
   * она известна достоверно. При выборке `all` — `null`, не догадка.
   */
  sentiment: ReviewSentiment | null;
}
