import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  criticExternalId,
  parseGameCard,
  parseGameList,
  parseReviews,
  parseScoreStats,
  ParseError,
} from '../src/clients/metacritic/parse.js';

/**
 * Парсеры проверяются на сохранённых фикстурах, не на сети (CLAUDE.md).
 * Происхождение каждой — `test/fixtures/metacritic/README.md`.
 */

const DIR = join(import.meta.dirname, 'fixtures', 'metacritic');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));

describe('списки finder', () => {
  it('New Releases разбирается в 20 игр со скорами', () => {
    const { totalResults, games } = parseGameList(fixture('finder-new-releases'));

    expect(games).toHaveLength(20);
    expect(totalResults).toBe(18524);
    expect(games[0]).toMatchObject({ slug: 'nba-2k27', title: 'NBA 2K27' });
    // metaScoreMin=1 — то, чем блок отличается от browse: скор есть у всех.
    expect(games.every((g) => g.metascore !== null)).toBe(true);
  });

  it('обложка собирается из bucketType и bucketPath', () => {
    const { games } = parseGameList(fixture('finder-new-releases'));

    expect(games[0]?.coverUrl).toBe(
      'https://www.metacritic.com/a/img/catalog/provider/7/2/7-1787423840.jpg',
    );
  });

  it('страница browse даёт 24 игры, и скоры у неё есть не у всех', () => {
    const { totalResults, games } = parseGameList(fixture('finder-browse-p1'));

    expect(games).toHaveLength(24);
    expect(totalResults).toBe(177945);
    expect(games.some((g) => g.metascore === null)).toBe(true);
  });

  it('битый элемент отбрасывается, остальной список выживает', () => {
    const raw = fixture('finder-new-releases') as {
      data: { items: unknown[] };
    };
    raw.data.items[3] = { title: 'без слага' };

    expect(parseGameList(raw).games).toHaveLength(19);
  });

  it('ответ неожиданной формы даёт ParseError, а не молчаливый пустой список', () => {
    expect(() => parseGameList({ foo: 'bar' })).toThrow(ParseError);
  });
});

describe('карточка игры', () => {
  it('даёт разработчика, платформы со скорами и ссылку на трейлер', () => {
    const card = parseGameCard(fixture('product-onimusha'));

    expect(card).toMatchObject({
      slug: 'onimusha-way-of-the-sword',
      developer: 'Capcom',
      publisher: 'Capcom',
      esrb: 'M',
      releaseDate: '2026-09-04',
      genres: ['Action Adventure'],
    });
    expect(card.videoUrl).toBe('https://cdn.jwplayer.com/players/Eibtv31Y.html');
    expect(card.description).toContain('swordplay');
  });

  it('раскладывает все четыре платформы с их Metascore', () => {
    const { platforms } = parseGameCard(fixture('product-onimusha'));

    expect(
      platforms.map((p) => [p.slug, p.metascore, p.criticCount]),
    ).toEqual([
      ['playstation-5', 85, 93],
      ['pc', 83, 28],
      ['xbox-series-x', 83, 10],
      ['nintendo-switch-2', 89, 12],
    ]);
    expect(platforms.filter((p) => p.isLead).map((p) => p.slug)).toEqual([
      'playstation-5',
    ]);
  });

  it('игра без данных даёт null, а не исключение и не выдуманный текст', () => {
    const card = parseGameCard(fixture('product-no-data'));

    expect(card).toMatchObject({
      slug: 'glow-in-the-shadows',
      description: null,
      videoUrl: null,
      esrb: null,
    });
    expect(card.platforms).toEqual([
      { name: 'PC', slug: 'pc', metascore: null, criticCount: null, isLead: true },
    ]);
    // Обложка есть даже у «шлака» — её отсутствие не подразумевается.
    expect(card.coverUrl).toMatch(/^https:\/\/www\.metacritic\.com\/a\/img\//);
    expect(card.developer).toBe('wanmeibd');
  });
});

describe('сводки оценок', () => {
  it('metascore читается по шкале 100', () => {
    expect(parseScoreStats(fixture('critic-stats'), 'critic')).toEqual({
      score: 85,
      max: 100,
      reviewCount: 90,
    });
  });

  it('userscore платформы PC — 9.3 по шкале 10, а не ведущей платформы', () => {
    expect(parseScoreStats(fixture('user-stats-pc'), 'user')).toEqual({
      score: 9.3,
      max: 10,
      reviewCount: 18,
    });
  });
});

describe('отзывы', () => {
  it('критики: 10 за запрос — потолок источника, не наш limit', () => {
    const { totalResults, reviews } = parseReviews(fixture('critic-list-ps5'), 'critic');

    expect(totalResults).toBe(93);
    expect(reviews).toHaveLength(10);
    expect(reviews[0]).toMatchObject({
      kind: 'critic',
      score: 100,
      scoreMax: 100,
      author: 'MonsterVine',
      date: '2026-08-31',
    });
  });

  it('критикам выводится устойчивый external_id, уникальный внутри выборки', () => {
    const { reviews } = parseReviews(fixture('critic-list-ps5'), 'critic');
    const ids = reviews.map((r) => r.externalId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toMatch(/^monstervine:[0-9a-f]{16}$/);
  });

  it('external_id критика не зависит от порядка и повторяем', () => {
    const arg = {
      publicationSlug: 'ign',
      url: 'https://ign.com/r/1',
      date: '2026-01-01',
      quote: 'text',
    };

    expect(criticExternalId(arg)).toBe(criticExternalId(arg));
    // Различает отзывы одного издания: иначе они схлопнутся по UNIQUE.
    expect(criticExternalId(arg)).not.toBe(
      criticExternalId({ ...arg, url: 'https://ign.com/r/2' }),
    );
  });

  it('пользователи: id источника, шкала 10, платформа отзыва', () => {
    const { reviews } = parseReviews(fixture('user-list-pc'), 'user');

    expect(reviews).toHaveLength(8);
    expect(reviews[0]).toMatchObject({
      externalId: '42c64909-985d-4afb-856f-f5b5f7f3da92',
      kind: 'user',
      score: 9,
      scoreMax: 10,
      author: 'woshixd174',
      platform: 'PC',
    });
  });

  it('отсутствие отзывов даёт пустой список, а не ошибку', () => {
    expect(parseReviews(fixture('critic-list-empty'), 'critic')).toEqual({
      totalResults: 0,
      reviews: [],
    });
  });
});
