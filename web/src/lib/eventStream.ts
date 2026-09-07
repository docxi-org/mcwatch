import { onBeforeUnmount, ref, type Ref } from 'vue';
import type { EventDto, StreamFrame, WorkerStatusDto } from '../api/types.js';

/**
 * Подписка на поток мониторинга. Своё переподключение вместо встроенного в
 * `EventSource`: браузер молча ретраит с непредсказуемой паузой, а экран
 * обязан честно сказать «нет связи, переподключение через N с»
 * (`docs/UI-BRIEF-MONITORING.md` §6).
 */

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export interface StreamHandlers {
  onStatus: (workers: WorkerStatusDto[], cycleRunning: boolean) => void;
  onEvent: (event: EventDto) => void;
}

export interface StreamHandle {
  connected: Ref<boolean>;
  /** Секунд до следующей попытки; 0 — попытка уже идёт. */
  reconnectIn: Ref<number>;
}

function parseFrame(raw: string): StreamFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const frame = parsed as { event?: unknown };
    if (frame.event === 'status' || frame.event === 'event') return parsed as StreamFrame;
    return null;
  } catch {
    // Битый кадр — не повод рвать подписку: следующий может быть целым.
    return null;
  }
}

export function useEventStream(handlers: StreamHandlers): StreamHandle {
  const connected = ref(false);
  const reconnectIn = ref(0);

  let source: EventSource | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const clearTimers = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    if (tickTimer) clearInterval(tickTimer);
    retryTimer = null;
    tickTimer = null;
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    const waitMs = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15000;
    attempt += 1;
    reconnectIn.value = Math.round(waitMs / 1000);

    tickTimer = setInterval(() => {
      reconnectIn.value = Math.max(0, reconnectIn.value - 1);
    }, 1000);

    retryTimer = setTimeout(() => {
      clearTimers();
      connect();
    }, waitMs);
  };

  function connect(): void {
    if (stopped) return;
    clearTimers();
    source?.close();

    const es = new EventSource('/api/events');
    source = es;

    es.onopen = (): void => {
      connected.value = true;
      reconnectIn.value = 0;
      attempt = 0;
    };

    es.onmessage = (message: MessageEvent<string>): void => {
      const frame = parseFrame(message.data);
      if (!frame) return;
      if (frame.event === 'status') handlers.onStatus(frame.data.workers, frame.data.cycleRunning);
      else handlers.onEvent(frame.data);
    };

    es.onerror = (): void => {
      connected.value = false;
      es.close();
      // Свой ретрай: браузерный не даёт ни отсчёта, ни отката.
      scheduleRetry();
    };
  }

  connect();

  onBeforeUnmount(() => {
    stopped = true;
    clearTimers();
    source?.close();
    source = null;
  });

  return { connected, reconnectIn };
}
