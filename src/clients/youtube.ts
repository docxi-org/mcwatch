import { setTimeout as delay } from 'node:timers/promises';
import { Innertube } from 'youtubei.js';
import { fetchTranscript as fetchTranscriptRaw } from 'youtube-transcript-plus';

/**
 * YouTube: поиск роликов и расшифровка речи. Ключ Data API не нужен ни для
 * того, ни для другого — разведка 07.09.2026, `docs/ARCHITECTURE.md` §6.
 *
 * Клиент только достаёт данные. Решение «тот ли это ролик» принимает модель
 * (`OpenRouterClient.judgeVideoMatch`): это семантика, и коду тут не место.
 */

export interface VideoCandidate {
  id: string;
  title: string;
  channel: string | null;
  views: number;
  durationS: number;
  url: string;
}

export class TranscriptUnavailableError extends Error {
  constructor(
    readonly videoId: string,
    reason: string,
  ) {
    super(`Расшифровка недоступна для ${videoId}: ${reason}`);
    this.name = 'TranscriptUnavailableError';
  }
}

/**
 * Отказ YouTube маскируется под «негодный идентификатор»: те же id через
 * минуту работают (§6). Отличаем настоящее отсутствие расшифровки от
 * временного отпора — первое повторять бессмысленно, второе обязательно.
 */
const PERMANENT_REFUSAL = /disabled|no transcript|not available|unavailable/i;

export interface YouTubeClientOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  /** Сколько кандидатов возвращает поиск. */
  maxCandidates?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_CANDIDATES = 5;

/** «1,234,567 views» → 1234567. Источник отдаёт просмотры только строкой. */
function parseViews(text: string | undefined): number {
  return Number((text ?? '').replace(/\D/g, '')) || 0;
}

/**
 * Форма ответа `youtube-transcript-plus`, объявленная у себя: в её `.d.ts`
 * относительные импорты без расширений, и под `moduleResolution: nodenext`
 * типы не разрешаются. Объявление на границе честнее, чем `any` внутри.
 */
interface TranscriptSegment {
  text: string;
  offset: number;
  duration: number;
}

const fetchTranscript = fetchTranscriptRaw as unknown as (
  videoId: string,
) => Promise<TranscriptSegment[]>;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Узел результата поиска youtubei.js: библиотека возвращает объединение
 * десятка типов, и нужные поля есть не у всех. Читаем их через одну
 * узкую форму, а не через россыпь проверок `in`.
 */
interface SearchNode {
  id?: string;
  title?: { text?: string };
  author?: { name?: string };
  view_count?: { text?: string };
  duration?: { seconds?: number };
}

export class YouTubeClient {
  private innertube: Innertube | null = null;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxCandidates: number;

  constructor(opts: YouTubeClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  }

  private async client(): Promise<Innertube> {
    this.innertube ??= await Innertube.create({ retrieve_player: false });
    return this.innertube;
  }

  /**
   * Кандидаты в летсплеи, по убыванию просмотров. По названию ничего не
   * отсеиваем: «обзор» в заголовке не делает ролик обзором, а отсутствие
   * названия игры не делает его чужим — это решает судья.
   */
  async findCandidates(gameTitle: string): Promise<VideoCandidate[]> {
    const yt = await this.client();
    const res = await this.withRetries(() => yt.search(`${gameTitle} let's play`, { type: 'video' }));

    return res.videos
      .flatMap((raw) => {
        const v = raw as SearchNode;
        const id = v.id;
        const title = v.title?.text;
        if (!id || !title) return [];
        return [
          {
            id,
            title,
            channel: v.author?.name ?? null,
            views: parseViews(v.view_count?.text),
            durationS: v.duration?.seconds ?? 0,
            url: `https://www.youtube.com/watch?v=${id}`,
          },
        ];
      })
      .sort((a, b) => b.views - a.views)
      .slice(0, this.maxCandidates);
  }

  /**
   * Расшифровка речи целиком. Судье и автору заключения уходит весь текст:
   * 13 тысяч токенов — это 7% контекста и меньше цента (§6), а урезание
   * заметно роняло качество суждения.
   */
  async fetchTranscript(videoId: string): Promise<string> {
    const segments = await this.withRetries(
      () => fetchTranscript(videoId),
      (err) => !PERMANENT_REFUSAL.test(errorText(err)),
    ).catch((err: unknown) => {
      throw new TranscriptUnavailableError(videoId, errorText(err).slice(0, 120));
    });

    const text = segments
      .map((seg) => seg.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Пустая расшифровка при формально успешном ответе — это «No Commentary»
    // либо отпор источника. Констатация формы, а не суждение о смысле.
    if (text.length === 0) {
      throw new TranscriptUnavailableError(videoId, 'расшифровка пуста');
    }
    return text;
  }

  private async withRetries<T>(
    attempt: () => Promise<T>,
    retryable: (err: unknown) => boolean = () => true,
  ): Promise<T> {
    let lastErr: unknown;

    for (let i = 1; i <= this.maxAttempts; i++) {
      try {
        return await Promise.race([
          attempt(),
          delay(this.timeoutMs).then(() => {
            throw new Error('таймаут запроса к YouTube');
          }),
        ]);
      } catch (err) {
        lastErr = err;
        if (i === this.maxAttempts || !retryable(err)) break;
        await delay(1000 * 2 ** (i - 1));
      }
    }

    throw lastErr;
  }
}
