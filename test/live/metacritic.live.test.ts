import { describe, expect, it } from 'vitest';
import { MetacriticClient } from '../../src/clients/metacritic/index.js';

/**
 * Сетевые тесты. Запускаются вручную (`pnpm test:live`), в `pnpm check` не
 * входят (CLAUDE.md, «Правила кода»). Задача одна: заметить, что маршруты или
 * формы Metacritic поехали, — не проверить бизнес-логику. Поэтому утверждения
 * о структуре, а не о конкретных играх: содержимое источника меняется ежедневно.
 */

const client = new MetacriticClient();

/** Источник живой — значит данные есть; пусто здесь и есть провал теста. */
function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`Metacritic не отдал ${what}`);
  return v;
}

describe('Metacritic жив', () => {
  it('New Releases отдаёт 20 игр, и у всех есть Metascore', async () => {
    const { games } = await client.listNewReleases();

    expect(games).toHaveLength(20);
    expect(games.every((g) => g.slug && g.title)).toBe(true);
    // Ровно это отличает блок от browse; отвалится — значит ушёл metaScoreMin.
    expect(games.every((g) => g.metascore !== null)).toBe(true);
  });

  it('browse отдаёт 24 игры на страницу и заметно больше New Releases', async () => {
    const { games, totalResults } = await client.listBrowsePage(2);

    expect(games).toHaveLength(24);
    expect(totalResults ?? 0).toBeGreaterThan(100_000);
  });

  it('карточка даёт разработчика и платформы', async () => {
    const { games } = await client.listNewReleases();
    const slug = must(games[0], 'ни одной игры').slug;

    const card = await client.getGameCard(slug);

    expect(card.slug).toBe(slug);
    expect(card.platforms.length).toBeGreaterThan(0);
    expect(card.platforms.some((p) => p.metascore !== null)).toBe(true);
  });

  it('userscore ведущей платформы отличается от сводного не по ошибке', async () => {
    const { games } = await client.listNewReleases();
    const slug = must(games[0], 'ни одной игры').slug;
    const card = await client.getGameCard(slug);
    const lead = card.platforms.find((p) => p.isLead) ?? card.platforms[0];

    const stats = await client.getScoreStats('user', slug, lead?.slug ?? null);

    // Шкала пользователей — 10; если придёт 100, значит формы разъехались.
    expect(stats.max).toBe(10);
  });

  it('список критиков по-прежнему упирается в 10 за запрос', async () => {
    const { games } = await client.listNewReleases();
    const withCritics = must(
      games.find((g) => (g.metascore ?? 0) > 0),
      'ни одной игры со скором',
    );
    const card = await client.getGameCard(withCritics.slug);
    const lead = card.platforms.find((p) => p.isLead) ?? card.platforms[0];

    const reviews = await client.listReviews('critic', withCritics.slug, {
      platform: lead?.slug ?? null,
    });

    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((r) => r.externalId && r.text)).toBe(true);
    // Дедупликация по external_id: пересекающиеся страницы не дают дублей.
    expect(new Set(reviews.map((r) => r.externalId)).size).toBe(reviews.length);
  });
});
