import type { Logger } from 'pino';
import type { OpenRouterClient } from '../clients/openrouter.js';
import {
  TranscriptUnavailableError,
  type VideoCandidate,
  type YouTubeClient,
} from '../clients/youtube.js';
import { componentLogger } from '../config/logger.js';
import { LETSPLAY_LIMITS } from '../config/models.js';
import type { Db } from '../db/index.js';
import {
  findGamesNeedingLetsplay,
  saveLetsplay,
  type PendingGame,
} from '../db/repo/letsplays.js';
import { nullReporter, type Reporter } from './monitor.js';

/**
 * Воркер летсплеев — `docs/ARCHITECTURE.md` §4.3, ТЗ доп. часть 1.
 *
 * Цепочка: поиск → по кандидатам в порядке популярности → расшифровка →
 * судья «та ли игра» → заключение. Код отвечает за факты (есть ли речь,
 * сколько просмотров), модель — за смысл (та ли игра, что автор сказал).
 */

export const WORKER = 'letsplay';

export interface LetsplayDeps {
  db: Db;
  youtube: YouTubeClient;
  llm: OpenRouterClient;
  now?: () => Date;
  log?: Logger;
  reporter?: Reporter;
  limit?: number;
}

/** Почему кандидат не подошёл. Записывается, а не теряется молча. */
export interface RejectedCandidate {
  videoId: string;
  title: string;
  reason: string;
}

export interface LetsplayResult {
  pending: number;
  done: number;
  noVideo: number;
  noTranscript: number;
  failed: number;
  /** Отвергнутые кандидаты по играм — чтобы потеря была видима. */
  rejected: Record<string, RejectedCandidate[]>;
}

interface Attempt {
  video: VideoCandidate;
  transcript: string;
}

/**
 * Первый кандидат, у которого есть речь и который судья признал той же игрой.
 * Порядок — по убыванию просмотров: «самый популярный ИЗ ПОДХОДЯЩИХ», а не
 * просто самый популярный (§6).
 */
async function pickVideo(
  deps: LetsplayDeps,
  game: PendingGame,
  candidates: VideoCandidate[],
  rejected: RejectedCandidate[],
  log: Logger,
): Promise<Attempt | null> {
  const gameInfo = {
    title: game.title,
    developer: game.developer,
    genres: game.genres ?? [],
    description: game.description,
  };

  for (const video of candidates.slice(0, LETSPLAY_LIMITS.maxCandidates)) {
    let transcript: string;
    try {
      transcript = await deps.youtube.fetchTranscript(video.id);
    } catch (err) {
      // Нет речи — факт, а не суждение: ролики «No Commentary» популярны
      // у прохождений, и заключение по ним делать не из чего.
      const reason =
        err instanceof TranscriptUnavailableError ? 'нет расшифровки' : String(err).slice(0, 80);
      rejected.push({ videoId: video.id, title: video.title, reason });
      continue;
    }

    const verdict = await deps.llm.judgeVideoMatch(
      gameInfo,
      { title: video.title, channel: video.channel },
      transcript,
    );

    // `low` — сомнение, а не приговор: на нём судья ошибался чаще всего (§6).
    if (verdict.matches && verdict.confidence !== 'low') {
      log.debug({ slug: game.slug, videoId: video.id, verdict }, 'кандидат принят');
      return { video, transcript };
    }

    rejected.push({
      videoId: video.id,
      title: video.title,
      reason: `судья: ${verdict.matches ? 'сомнение' : 'другая игра'} — ${verdict.reason}`,
    });
  }

  return null;
}

export async function runLetsplayOnce(deps: LetsplayDeps): Promise<LetsplayResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? componentLogger('letsplay');
  const report = deps.reporter ?? nullReporter;

  report.started(WORKER);
  const pending = findGamesNeedingLetsplay(db, deps.limit ?? 20);
  const result: LetsplayResult = {
    pending: pending.length,
    done: 0,
    noVideo: 0,
    noTranscript: 0,
    failed: 0,
    rejected: {},
  };

  log.info({ pending: pending.length }, 'прогон летсплеев начат');

  for (const game of pending) {
    report.checked(WORKER);
    report.item(WORKER, game.title);
    const rejected: RejectedCandidate[] = [];

    try {
      const candidates = await deps.youtube.findCandidates(game.title);
      const picked = candidates.length === 0 ? null : await pickVideo(deps, game, candidates, rejected, log);

      if (!picked) {
        // Различаем «ролики были, но все чужие или без речи» и «ничего не нашлось».
        const noSpeech = rejected.length > 0 && rejected.every((r) => r.reason === 'нет расшифровки');
        const status = candidates.length === 0 ? 'no_video' : noSpeech ? 'no_transcript' : 'no_video';
        saveLetsplay(db, game.slug, {
          videoId: null,
          title: null,
          channel: null,
          views: null,
          durationS: null,
          conclusion: null,
          status,
          lastError: null,
        }, now());
        if (status === 'no_video') result.noVideo++;
        else result.noTranscript++;
        report.log(WORKER, 'info', `летсплей не подобран: ${game.title}`, {
          отвергнуто: rejected.length,
          причины: rejected.map((r) => r.reason),
        });
      } else {
        const conclusion = await deps.llm.concludeLetsplay(
          {
            title: game.title,
            developer: game.developer,
            genres: game.genres ?? [],
            description: game.description,
          },
          { title: picked.video.title, channel: picked.video.channel },
          picked.transcript,
        );

        saveLetsplay(db, game.slug, {
          videoId: picked.video.id,
          title: picked.video.title,
          channel: picked.video.channel,
          views: picked.video.views,
          durationS: picked.video.durationS,
          conclusion: JSON.stringify(conclusion),
          status: 'done',
          lastError: null,
        }, now());
        result.done++;
        report.processed(WORKER);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      saveLetsplay(db, game.slug, {
        videoId: null,
        title: null,
        channel: null,
        views: null,
        durationS: null,
        conclusion: null,
        status: 'failed',
        lastError: message,
      }, now());
      result.failed++;
      report.failed(WORKER);
      report.log(WORKER, 'warn', `летсплей не сделан: ${game.title}`, { error: message });
      log.warn({ err, slug: game.slug }, 'летсплей не сделан, идём дальше');
    }

    if (rejected.length > 0) result.rejected[game.slug] = rejected;
  }

  log.info(
    { done: result.done, noVideo: result.noVideo, noTranscript: result.noTranscript, failed: result.failed },
    'прогон летсплеев завершён',
  );
  report.log(
    WORKER,
    'info',
    `прогон завершён · рассмотрено игр: ${result.pending} · заключений: ${result.done} · ` +
      `без подходящего ролика: ${result.noVideo} · без речи: ${result.noTranscript}` +
      (result.failed > 0 ? ` · сбоев: ${result.failed}` : ''),
    {
      pending: result.pending,
      done: result.done,
      noVideo: result.noVideo,
      noTranscript: result.noTranscript,
      failed: result.failed,
    },
  );
  report.finished(WORKER);
  return result;
}
