import { createHash } from 'node:crypto';
import { z } from 'zod';
import { imageUrl, videoUrlFromJwPlayerId } from './endpoints.js';
import type {
  GameCard,
  GamePlatform,
  ListedGame,
  Review,
  ReviewKind,
  ReviewSentiment,
  ScoreStats,
} from './types.js';

/**
 * Разбор ответов JSON-бэкенда. Схемы снисходительны намеренно: Metacritic
 * меняет форму без предупреждения, и неизвестное поле не должно ронять обход
 * (CLAUDE.md, «Правила кода»). Обязательны только те поля, без которых запись
 * бессмысленна: `slug` и `title`.
 */

export class ParseError extends Error {
  constructor(what: string, cause: unknown) {
    super(`Не удалось разобрать ${what}`);
    this.name = 'ParseError';
    this.cause = cause;
  }
}

/** Число либо null: источник шлёт и `null`, и отсутствие ключа, и строки. */
const num = z.coerce.number().nullish().catch(null);
const str = z.string().nullish().catch(null);

const imageSchema = z
  .object({ bucketType: str, bucketPath: str, typeName: str })
  .nullish()
  .catch(null);

const scoreSummarySchema = z
  .object({ score: num, max: num, reviewCount: num })
  .nullish()
  .catch(null);

const genresSchema = z
  .array(z.object({ name: str }))
  .nullish()
  .catch(null);

function genreNames(raw: z.infer<typeof genresSchema>): string[] {
  return (raw ?? []).map((g) => g.name).filter((n): n is string => !!n);
}

/** Пустая строка от источника — это отсутствие данных, а не значение. */
function blankToNull(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

// ── Списки (finder) ────────────────────────────────────────────────────────

const listItemSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  releaseDate: str,
  image: imageSchema,
  criticScoreSummary: scoreSummarySchema,
  genres: genresSchema,
});

const listSchema = z.object({
  data: z.object({
    totalResults: num,
    items: z.array(z.unknown()),
  }),
});

export interface ParsedList {
  totalResults: number | null;
  games: ListedGame[];
  /**
   * Сколько элементов ответа не прошли схему и отброшены. Молчаливо
   * укоротившийся список неотличим от честно короткого — вызывающий код
   * должен иметь возможность это заметить и залогировать.
   */
  skipped: number;
}

/**
 * Разбирает ответ finder. Элемент, не прошедший схему, отбрасывается, а не
 * роняет весь список: у Metacritic в потоке browse встречается что угодно.
 */
export function parseGameList(raw: unknown): ParsedList {
  const outer = listSchema.safeParse(raw);
  if (!outer.success) throw new ParseError('список игр', outer.error);

  const games: ListedGame[] = [];
  let skipped = 0;
  for (const item of outer.data.data.items) {
    const parsed = listItemSchema.safeParse(item);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const it = parsed.data;
    games.push({
      slug: it.slug,
      title: it.title,
      releaseDate: blankToNull(it.releaseDate),
      coverUrl: imageUrl(it.image?.bucketType ?? null, it.image?.bucketPath ?? null),
      metascore: it.criticScoreSummary?.score ?? null,
      genres: genreNames(it.genres),
    });
  }

  return { totalResults: outer.data.data.totalResults ?? null, games, skipped };
}

// ── Карточка ───────────────────────────────────────────────────────────────

const companySchema = z.object({ typeName: str, name: str });

const platformSchema = z.object({
  name: z.string().min(1),
  slug: str,
  criticScoreSummary: scoreSummarySchema,
  isLeadPlatform: z.boolean().nullish().catch(null),
});

const cardSchema = z.object({
  data: z.object({
    item: z.object({
      slug: z.string().min(1),
      title: z.string().min(1),
      description: str,
      releaseDate: str,
      rating: str,
      genres: genresSchema,
      images: z.array(imageSchema).nullish().catch(null),
      video: z
        .object({ jwPlayerId: str })
        .nullish()
        .catch(null),
      production: z
        .object({ companies: z.array(companySchema).nullish().catch(null) })
        .nullish()
        .catch(null),
      platforms: z.array(z.unknown()).nullish().catch(null),
    }),
  }),
});

/** Компания по роли: одна и та же может быть и разработчиком, и издателем. */
function companyByRole(
  companies: z.infer<typeof companySchema>[] | null | undefined,
  role: string,
): string | null {
  const hit = (companies ?? []).find(
    (c) => c.typeName?.toLowerCase() === role.toLowerCase(),
  );
  return blankToNull(hit?.name);
}

/** Обложка карточки: предпочитаем `cardImage`, иначе первую доступную. */
function pickCover(images: z.infer<typeof imageSchema>[] | null | undefined): string | null {
  const list = (images ?? []).filter((i) => !!i);
  const preferred = list.find((i) => i.typeName === 'cardImage') ?? list[0];
  return imageUrl(preferred?.bucketType ?? null, preferred?.bucketPath ?? null);
}

export function parseGameCard(raw: unknown): GameCard {
  const parsed = cardSchema.safeParse(raw);
  if (!parsed.success) throw new ParseError('карточку игры', parsed.error);
  const it = parsed.data.data.item;

  const platforms: GamePlatform[] = [];
  for (const p of it.platforms ?? []) {
    const pp = platformSchema.safeParse(p);
    if (!pp.success) continue;
    platforms.push({
      name: pp.data.name,
      slug: blankToNull(pp.data.slug),
      metascore: pp.data.criticScoreSummary?.score ?? null,
      criticCount: pp.data.criticScoreSummary?.reviewCount ?? null,
      isLead: pp.data.isLeadPlatform === true,
    });
  }

  return {
    slug: it.slug,
    title: it.title,
    description: blankToNull(it.description),
    developer: companyByRole(it.production?.companies, 'Developer'),
    publisher: companyByRole(it.production?.companies, 'Publisher'),
    genres: genreNames(it.genres),
    releaseDate: blankToNull(it.releaseDate),
    esrb: blankToNull(it.rating),
    coverUrl: pickCover(it.images),
    videoUrl: videoUrlFromJwPlayerId(blankToNull(it.video?.jwPlayerId)),
    platforms,
  };
}

// ── Оценки ─────────────────────────────────────────────────────────────────

const statsSchema = z.object({
  data: z.object({
    item: z.object({ score: num, max: num, reviewCount: num }),
  }),
});

export function parseScoreStats(raw: unknown, kind: ReviewKind): ScoreStats {
  const parsed = statsSchema.safeParse(raw);
  if (!parsed.success) throw new ParseError('сводку оценок', parsed.error);
  const it = parsed.data.data.item;

  const reviewCount = it.reviewCount ?? null;
  // Когда оценок нет, для пользователей источник шлёт не null, а score 0 —
  // асимметрично критикам (§6). Сохранить это значило бы утверждать «игроки
  // поставили 0 из 10» там, где не поставил никто. Пустое — null (CLAUDE.md).
  const hasVotes = reviewCount !== null && reviewCount > 0;

  return {
    score: hasVotes ? (it.score ?? null) : null,
    // Шкалы не смешивать: 100 у критиков, 10 у пользователей (§3).
    max: it.max ?? (kind === 'critic' ? 100 : 10),
    reviewCount,
  };
}

// ── Отзывы ─────────────────────────────────────────────────────────────────

const reviewSchema = z.object({
  id: str,
  quote: z.string().min(1),
  score: num,
  date: str,
  author: str,
  url: str,
  publicationName: str,
  publicationSlug: str,
  reviewedProduct: z
    .object({ platform: z.object({ name: str }).nullish().catch(null) })
    .nullish()
    .catch(null),
});

const reviewListSchema = z.object({
  data: z.object({ totalResults: num, items: z.array(z.unknown()) }),
});

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/**
 * У отзыва критика нет `id` (§6), а схема требует `external_id`. Выводим
 * детерминированно: издание плюс хеш того, что отличает отзыв внутри издания.
 * Читаемый префикс оставлен намеренно — по нему видно источник в отладке.
 */
export function criticExternalId(r: {
  publicationSlug: string | null;
  url: string | null;
  date: string | null;
  quote: string;
}): string {
  const prefix = r.publicationSlug ?? 'unknown';
  const material = r.url ?? `${r.date ?? ''}|${r.quote}`;
  return `${prefix}:${sha1(material).slice(0, 16)}`;
}

export interface ParsedReviews {
  totalResults: number | null;
  reviews: Review[];
  /** См. `ParsedList.skipped`. */
  skipped: number;
}

/** Тональность источника в словарь схемы: `neutral` у нас зовётся `mixed`. */
export function toSchemaSentiment(
  s: 'positive' | 'neutral' | 'negative',
): ReviewSentiment {
  return s === 'neutral' ? 'mixed' : s;
}

/**
 * @param sentiment Тональность запроса. Передаётся, когда список получен
 *   фильтром `filterBySentiment`: тогда она достоверна для каждого элемента.
 */
export function parseReviews(
  raw: unknown,
  kind: ReviewKind,
  sentiment: ReviewSentiment | null = null,
): ParsedReviews {
  const outer = reviewListSchema.safeParse(raw);
  if (!outer.success) throw new ParseError('список отзывов', outer.error);

  const scoreMax = kind === 'critic' ? 100 : 10;
  const reviews: Review[] = [];
  let skipped = 0;

  for (const item of outer.data.data.items) {
    const parsed = reviewSchema.safeParse(item);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const r = parsed.data;

    const externalId =
      kind === 'user'
        ? blankToNull(r.id)
        : criticExternalId({
            publicationSlug: blankToNull(r.publicationSlug),
            url: blankToNull(r.url),
            date: blankToNull(r.date),
            quote: r.quote,
          });
    if (!externalId) {
      skipped++;
      continue;
    }

    reviews.push({
      externalId,
      kind,
      text: r.quote.trim(),
      score: r.score ?? null,
      scoreMax,
      // У критиков автором выступает издание: личное имя часто пустое.
      author: blankToNull(kind === 'critic' ? r.publicationName : r.author),
      date: blankToNull(r.date),
      url: blankToNull(r.url),
      platform: blankToNull(r.reviewedProduct?.platform?.name),
      sentiment,
    });
  }

  return { totalResults: outer.data.data.totalResults ?? null, reviews, skipped };
}
