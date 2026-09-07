import { createHash } from 'node:crypto';
import { and, eq, notInArray } from 'drizzle-orm';
import type { GameCard } from '../../clients/metacritic/index.js';
import type { Db } from '../index.js';
import { gamePlatforms, games } from '../schema.js';

/**
 * Запись собранного в БД. Игра, уже существующая в базе, обновляется, а не
 * пропускается (`docs/ARCHITECTURE.md` §2).
 */

/** Оценки платформы: metascore приходит с карточки, userscore — отдельно (§6). */
export interface PlatformScores {
  name: string;
  slug: string | null;
  metascore: number | null;
  criticCount: number | null;
  userscore: number | null;
  userCount: number | null;
}

/**
 * Материал эмбеддинга (§4.2). Хеш считается по всему тексту, а не только по
 * описанию: смена жанров или разработчика тоже требует пересчёта. Имя колонки
 * `description_hash` осталось историческим.
 */
export function embeddingText(card: GameCard): string {
  return [card.title, card.genres.join(', '), card.developer, card.description]
    .filter((p) => !!p)
    .join(' · ');
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Вставляет или обновляет игру. `first_seen` при обновлении не трогается. */
export function upsertGame(db: Db, card: GameCard, now: Date): void {
  const row = {
    slug: card.slug,
    title: card.title,
    coverUrl: card.coverUrl,
    videoUrl: card.videoUrl,
    developer: card.developer,
    publisher: card.publisher,
    genres: card.genres,
    description: card.description,
    releaseDate: card.releaseDate,
    esrb: card.esrb,
    descriptionHash: hash(embeddingText(card)),
    lastCrawled: now,
    status: 'ok' as const,
    lastError: null,
  };

  db.insert(games)
    .values({ ...row, firstSeen: now })
    .onConflictDoUpdate({ target: games.slug, set: row })
    .run();
}

/**
 * Помечает игру неудачной, не затирая ранее собранные поля: ошибка одного
 * элемента не должна стирать то, что уже получилось (CLAUDE.md, «Правила кода»).
 */
export function markGameFailed(
  db: Db,
  slug: string,
  title: string,
  error: string,
  now: Date,
): void {
  db.insert(games)
    .values({
      slug,
      title,
      firstSeen: now,
      lastCrawled: now,
      status: 'failed',
      lastError: error,
    })
    .onConflictDoUpdate({
      target: games.slug,
      set: { lastCrawled: now, status: 'failed', lastError: error },
    })
    .run();
}

/**
 * Приводит набор платформ игры к текущему: обновляет пришедшие и удаляет
 * исчезнувшие. Пустой набор оставляет прежние строки нетронутыми — «карточка
 * не отдала платформ» и «у игры их больше нет» различать нечем.
 */
export function replacePlatforms(
  db: Db,
  slug: string,
  platforms: PlatformScores[],
): void {
  if (platforms.length === 0) return;

  db.transaction((tx) => {
    for (const p of platforms) {
      const scores = {
        metascore: p.metascore,
        userscore: p.userscore,
        criticCount: p.criticCount,
        userCount: p.userCount,
      };
      tx.insert(gamePlatforms)
        .values({ gameSlug: slug, platform: p.name, ...scores })
        .onConflictDoUpdate({
          target: [gamePlatforms.gameSlug, gamePlatforms.platform],
          set: scores,
        })
        .run();
    }

    tx.delete(gamePlatforms)
      .where(
        and(
          eq(gamePlatforms.gameSlug, slug),
          notInArray(
            gamePlatforms.platform,
            platforms.map((p) => p.name),
          ),
        ),
      )
      .run();
  });
}
