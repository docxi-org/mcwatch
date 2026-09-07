import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../src/workers/pipeline.js';
import { Scheduler, type Stage } from '../src/workers/scheduler.js';

/**
 * Планировщик проверяется на подменённых часах и таймерах: тест не ждёт
 * реального времени и не трогает сеть.
 */

const log = pino({ level: 'silent' });

/** Часы и таймеры, которыми управляет тест. */
function fakeClock(startIso = '2026-09-07T12:00:00Z') {
  let now = new Date(startIso).getTime();
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;

  return {
    now: () => new Date(now),
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimer: (t: NodeJS.Timeout) => {
      const idx = timers.findIndex((x) => x.id === (t as unknown as number));
      if (idx !== -1) timers.splice(idx, 1);
    },
    /**
     * Двигает время и запускает всё, чей срок наступил. Асинхронный: цикл
     * планирует следующий запуск в `.finally()`, то есть на микрозадаче, —
     * без ожидания следующий таймер просто не успел бы зарегистрироваться.
     */
    advance: async (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      for (const t of due) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    pending: () => timers.length,
  };
}

function stage(name: string, calls: string[], fail = false): Stage {
  return {
    name,
    run: () => {
      calls.push(name);
      return fail ? Promise.reject(new Error(`${name} упал`)) : Promise.resolve();
    },
  };
}

function make(
  clock: ReturnType<typeof fakeClock>,
  stages: Stage[],
  lastRunAt: Date | null,
) {
  return new Scheduler({
    stages,
    intervalMs: HOUR_MS,
    lastRunAt: () => lastRunAt,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log,
  });
}

describe('порядок и устойчивость цикла', () => {
  it('этапы идут в объявленном порядке', async () => {
    const calls: string[] = [];
    const clock = fakeClock();
    const s = make(clock, ['crawl', 'summarize', 'embed'].map((n) => stage(n, calls)), null);

    await s.runCycle();

    expect(calls).toEqual(['crawl', 'summarize', 'embed']);
  });

  it('сбой этапа не отменяет следующие', async () => {
    const calls: string[] = [];
    const clock = fakeClock();
    const s = make(
      clock,
      [stage('crawl', calls, true), stage('summarize', calls), stage('embed', calls)],
      null,
    );

    const result = await s.runCycle();

    // Резюме нужны и по тем играм, что уже в базе, даже если обход не удался.
    expect(calls).toEqual(['crawl', 'summarize', 'embed']);
    expect(result?.stages.map((x) => [x.name, x.ok])).toEqual([
      ['crawl', false],
      ['summarize', true],
      ['embed', true],
    ]);
    expect(result?.stages[0]?.error).toContain('crawl упал');
  });

  it('повторный запуск во время работы пропускается, а не идёт вторым', async () => {
    const clock = fakeClock();
    // `undefined`, а не `void`: тип-аргумент — не место для `void`.
    const { promise, resolve } = Promise.withResolvers<undefined>();
    const slow: Stage = {
      name: 'slow',
      run: async () => {
        await promise;
      },
    };
    const s = make(clock, [slow], null);

    const first = s.runCycle();
    expect(s.isRunning).toBe(true);
    const second = await s.runCycle();

    // Два обхода к Metacritic одновременно недопустимы.
    expect(second).toBeNull();
    resolve(undefined);
    await first;
    expect(s.isRunning).toBe(false);
  });

  it('после завершения цикла можно запускать снова', async () => {
    const calls: string[] = [];
    const clock = fakeClock();
    const s = make(clock, [stage('crawl', calls)], null);

    await s.runCycle();
    await s.runCycle();

    expect(calls).toEqual(['crawl', 'crawl']);
  });
});

describe('расписание', () => {
  it('без прошлых обходов запускается сразу', () => {
    const clock = fakeClock();

    expect(make(clock, [], null).delayBeforeFirstRun()).toBe(0);
  });

  it('если обход был только что — ждёт остаток часа', () => {
    const clock = fakeClock('2026-09-07T12:00:00Z');
    const s = make(clock, [], new Date('2026-09-07T11:50:00Z'));

    // Обход был 10 минут назад, значит ждать оставшиеся 50.
    // Перезапуск контейнера не должен означать новый обход источника.
    expect(s.delayBeforeFirstRun()).toBe(50 * 60 * 1000);
  });

  it('если с прошлого обхода прошёл час — запускается сразу', () => {
    const clock = fakeClock('2026-09-07T12:00:00Z');
    const s = make(clock, [], new Date('2026-09-07T10:00:00Z'));

    expect(s.delayBeforeFirstRun()).toBe(0);
  });

  it('после старта цикл повторяется каждый час', async () => {
    const calls: string[] = [];
    const clock = fakeClock();
    const s = make(clock, [stage('crawl', calls)], null);

    s.start();
    await clock.advance(0);
    await clock.advance(HOUR_MS);
    await clock.advance(HOUR_MS);
    s.stop();

    expect(calls).toEqual(['crawl', 'crawl', 'crawl']);
  });

  it('остановка снимает запланированный запуск', async () => {
    const calls: string[] = [];
    const clock = fakeClock();
    const s = make(clock, [stage('crawl', calls)], new Date('2026-09-07T11:59:00Z'));

    s.start();
    expect(clock.pending()).toBe(1);
    s.stop();
    await clock.advance(HOUR_MS * 3);

    expect(calls).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
