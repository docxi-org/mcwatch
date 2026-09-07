/**
 * Формы ответов API берутся у бэкенда напрямую (`src/api/types.ts`), а не
 * переписываются копией: бриф требует одного источника правды, и при
 * расхождении сборка обязана падать, а не отдавать выдуманные поля.
 *
 * Импорт типовой — в собранном коде от него не остаётся ничего.
 */
export type {
  GameCardDto,
  PipelineCandidateDto,
  PipelineDto,
  PipelineRunDto,
  PipelineStageDto,
  PipelineTotalsDto,
  GameListDto,
  GameListItemDto,
  LetsplayDto,
  PlatformDto,
  PlatformScoreDto,
  SimilarGameDto,
  SortKey,
  SummaryDto,
} from '../../../src/api/types.js';

/** Состояние воркера — `docs/UI-BRIEF-MONITORING.md` §5. */
export interface WorkerStatusDto {
  worker: string;
  state: 'idle' | 'running' | 'error';
  currentItem: string | null;
  /** Рассмотрено единиц. Всегда ≥ `processedTotal`. */
  checkedTotal: number;
  processedTotal: number;
  failedTotal: number;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface CrawlStateDto {
  date: string;
  phase: 'landing' | 'browse';
  nextPage: number;
  processedToday: number;
  /** Адрес на Metacritic, который возьмёт следующий заход. */
  nextUrl: string;
}

export interface EventDto {
  id: number;
  ts: string;
  worker: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  data: unknown;
}

/** Раскладка летсплеев по исходам: куда делись рассмотренные игры. */
export interface LetsplayOutcomesDto {
  done: number;
  noVideo: number;
  noTranscript: number;
  failed: number;
  pending: number;
}

export interface StatusDto {
  workers: WorkerStatusDto[];
  crawl: CrawlStateDto | null;
  cycleRunning: boolean;
  schedulerEnabled: boolean;
  letsplayOutcomes: LetsplayOutcomesDto;
  events: EventDto[];
  serverTime: string;
}

/** Кадр потока SSE. `ping` до подписчика не доходит — он приходит своим типом. */
export type StreamFrame =
  | { event: 'status'; data: { workers: WorkerStatusDto[]; cycleRunning: boolean } }
  | { event: 'event'; data: EventDto };
