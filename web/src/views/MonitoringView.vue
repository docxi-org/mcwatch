<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchStatus, runCrawl, type RunOutcome } from '../api/client.js';
import type { CrawlStateDto, EventDto, WorkerStatusDto } from '../api/types.js';
import { useEventStream } from '../lib/eventStream.js';
import { agoText, clockText } from '../lib/format.js';

/**
 * Служебный экран: статусы воркеров, счётчики, журнал и принудительный
 * запуск (`docs/UI-BRIEF-MONITORING.md`).
 *
 * Живость видна не по журналу: между «начал» и «закончил» проходят минуты
 * тишины. Признак работы — «чем занят» и счётчики, они меняются на каждой
 * записи и приходят снимками SSE.
 */

const ROLE: Record<string, string> = {
  crawler: 'ОБХОДИТ METACRITIC',
  summarizer: 'ПРОСИТ РЕЗЮМЕ У НЕЙРОСЕТИ',
  embedder: 'СЧИТАЕТ ВЕКТОРЫ',
  letsplay: 'ИЩЕТ ЛЕТСПЛЕИ',
};

const STATE_TEXT: Record<WorkerStatusDto['state'], string> = {
  idle: 'IDLE',
  running: 'RUNNING',
  error: 'ERROR',
};

const PHASE_NOTE: Record<CrawlStateDto['phase'], string> = {
  landing: 'первые 20 игр с главной',
  browse: 'очередная страница общего списка',
};

const RUN_RESULT: Record<Exclude<RunOutcome, never>, { code: string; text: string; tone: string }> =
  {
    202: {
      code: '202',
      text: 'Цикл запущен. Ответ пришёл сразу — прогресс смотрите по «чем занят» и счётчикам, это займёт минуты.',
      tone: 'accent',
    },
    409: {
      code: '409',
      text: 'Цикл уже идёт — повторный запуск не нужен. Это не ошибка.',
      tone: 'plain',
    },
    503: {
      code: '503',
      text: 'Планировщик выключен в настройках сервиса. Запуск недоступен, пока его не включат на сервере.',
      tone: 'warn',
    },
    failed: {
      code: 'сбой',
      text: 'Запрос на запуск не дошёл до сервиса. Проверьте связь и попробуйте ещё раз.',
      tone: 'warn',
    },
  };

const workers = ref<WorkerStatusDto[]>([]);
const crawl = ref<CrawlStateDto | null>(null);
const events = ref<EventDto[]>([]);
const cycleRunning = ref(false);
const schedulerEnabled = ref(true);
const loaded = ref(false);
const openIds = ref<number[]>([]);
const runOutcome = ref<RunOutcome | null>(null);
const running = ref(false);

/**
 * Часы сервера, а не браузера: «5 минут назад» по чужим часам врёт, если
 * они сбиты. Держим сдвиг и подтикиваем локально.
 */
const skewMs = ref(0);
const tick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

const serverNow = computed(() => tick.value + skewMs.value);

let statusTimer: ReturnType<typeof setTimeout> | null = null;

async function loadStatus(): Promise<void> {
  try {
    const snapshot = await fetchStatus();
    workers.value = snapshot.workers;
    crawl.value = snapshot.crawl;
    events.value = snapshot.events;
    cycleRunning.value = snapshot.cycleRunning;
    schedulerEnabled.value = snapshot.schedulerEnabled;
    skewMs.value = new Date(snapshot.serverTime).getTime() - Date.now();
    loaded.value = true;
  } catch {
    // Снимок не пришёл — поток всё равно поднимется и покажет состояние.
    loaded.value = true;
  }
}

/**
 * Кадр `status` несёт только воркеров и признак цикла — фазу обхода и журнал
 * он не содержит. Поэтому на каждое событие журнала дотягиваем снимок, но не
 * чаще раза в пять секунд.
 */
function refreshSoon(): void {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    void loadStatus();
  }, 5000);
}

const stream = useEventStream({
  onStatus: (nextWorkers, nextCycleRunning) => {
    workers.value = nextWorkers;
    cycleRunning.value = nextCycleRunning;
    loaded.value = true;
  },
  onEvent: (event) => {
    events.value = [event, ...events.value].slice(0, 100);
    refreshSoon();
  },
});

async function onRun(): Promise<void> {
  running.value = true;
  runOutcome.value = await runCrawl();
  running.value = false;
  if (runOutcome.value === 202) cycleRunning.value = true;
  if (runOutcome.value === 503) schedulerEnabled.value = false;
}

function toggleData(id: number): void {
  openIds.value = openIds.value.includes(id)
    ? openIds.value.filter((x) => x !== id)
    : [...openIds.value, id];
}

onMounted(() => {
  void loadStatus();
  tickTimer = setInterval(() => {
    tick.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (statusTimer) clearTimeout(statusTimer);
});

// ── Производные ────────────────────────────────────────────────────────────

const activeWorker = computed(() => workers.value.find((w) => w.state === 'running'));

const cycleCard = computed(() => {
  if (cycleRunning.value && stream.connected.value) {
    return {
      title: 'Цикл идёт',
      note: activeWorker.value
        ? `сейчас работает ${activeWorker.value.worker} · снимок состояния приходит на каждую запись`
        : 'ждём первый снимок',
      tone: 'accent',
      alive: true,
    };
  }
  if (!schedulerEnabled.value) {
    return {
      title: 'Планировщик выключен',
      note: 'автоматических циклов нет · schedulerEnabled: false',
      tone: 'warn',
      alive: false,
    };
  }
  return {
    title: 'Простой',
    note: 'следующий автоматический цикл в начале часа',
    tone: 'idle',
    alive: false,
  };
});

const runDisabled = computed(
  () => !schedulerEnabled.value || cycleRunning.value || running.value || !stream.connected.value,
);

const runLabel = computed(() => (cycleRunning.value ? 'Цикл уже идёт' : 'Запустить сейчас'));

const outcome = computed(() => (runOutcome.value ? RUN_RESULT[runOutcome.value] : null));

/** Пустой журнал при живом цикле — обычное дело, и это надо объяснить. */
const quietJournal = computed(() => loaded.value && events.value.length === 0);
</script>

<template>
  <div class="mon">
    <div class="conn" role="status">
      <span class="conn__dot" :class="stream.connected.value ? 'conn__dot--live' : 'conn__dot--off'"></span>
      <span class="conn__text mono" :class="{ 'conn__text--off': !stream.connected.value }">{{
        stream.connected.value
          ? `поток подключён · ${clockText(new Date(serverNow).toISOString())}`
          : `нет связи · переподключение через ${stream.reconnectIn.value} с`
      }}</span>
    </div>

    <div v-if="!stream.connected.value && loaded" class="offline" role="status">
      <span class="offline__badge mono">SSE</span>
      <span class="offline__body">
        <span class="offline__text"
          >Поток событий оборвался — возможно, сервис перезапускается. Пробуем подключиться
          заново, счётчики пока не обновляются.</span
        >
        <span class="offline__note mono"
          >Числа ниже — последний полученный снимок, они могли устареть.</span
        >
      </span>
    </div>

    <section class="top">
      <div class="cycle" :class="`cycle--${cycleCard.tone}`">
        <span class="cycle__dot" :class="{ 'cycle__dot--alive': cycleCard.alive }"></span>
        <span class="cycle__body">
          <span class="cycle__title">{{ cycleCard.title }}</span>
          <span class="cycle__note mono">{{ cycleCard.note }}</span>
        </span>
      </div>
      <button
        type="button"
        class="run"
        :class="{ 'run--off': runDisabled }"
        :disabled="runDisabled"
        @click="onRun"
      >
        {{ runLabel }}
      </button>
    </section>

    <div v-if="outcome" class="outcome" :class="`outcome--${outcome.tone}`" role="status">
      <span class="outcome__code mono">{{ outcome.code }}</span>
      <span class="outcome__text">{{ outcome.text }}</span>
    </div>

    <!-- Свежий сервис: воркеров нет вовсе. Это не сбой, а «работы ещё не было». -->
    <div v-if="loaded && workers.length === 0" class="empty empty--fresh">
      <span class="empty__title">Работы ещё не было</span>
      <span class="empty__note"
        >Сервис запущен, но ни один воркер пока не отработал: счётчиков и журнала нет, обход не
        начинался. Первый цикл пойдёт автоматически в начале часа — или нажмите «Запустить
        сейчас».</span
      >
      <span class="empty__tech mono">GET /api/status → workers: [], crawl: null</span>
    </div>

    <template v-else-if="workers.length > 0">
      <section class="section section--gap">
        <div class="section__head">
          <h2 class="section__title">Воркеры</h2>
          <span class="section__note">идут по очереди · сбой этапа не отменяет следующие</span>
        </div>

        <div class="workers">
          <div
            v-for="w in workers"
            :key="w.worker"
            class="worker"
            :class="`worker--${w.state}`"
          >
            <div class="worker__head">
              <span class="worker__name mono">{{ w.worker }}</span>
              <span class="worker__pill mono">
                <span class="worker__pilldot"></span>{{ STATE_TEXT[w.state] }}
              </span>
            </div>

            <div class="worker__now">
              <span class="worker__role mono">{{ ROLE[w.worker] ?? 'ЭТАП ЦИКЛА' }}</span>
              <span class="worker__item" :class="{ 'worker__item--idle': !w.currentItem }">{{
                w.currentItem ?? (w.state === 'error' ? 'остановлен на ошибке' : 'ничего не делает')
              }}</span>
            </div>

            <div class="worker__counters">
              <span class="counter">
                <span class="counter__value mono">{{ w.processedTotal }}</span>
                <span class="counter__label mono">ОБРАБОТАНО</span>
              </span>
              <span class="counter">
                <span
                  class="counter__value mono"
                  :class="{
                    'counter__value--warn': w.failedTotal > 0 && w.failedTotal <= w.processedTotal,
                    'counter__value--bad': w.failedTotal > w.processedTotal,
                  }"
                  >{{ w.failedTotal }}</span
                >
                <span class="counter__label mono">ОШИБОК</span>
              </span>
            </div>

            <span class="worker__last mono"
              >последний прогон: {{ agoText(w.lastRunAt, serverNow) }}</span
            >

            <span v-if="w.lastError" class="worker__err">
              <span class="worker__errlabel mono">ПОСЛЕДНЯЯ ОШИБКА</span>
              <span class="worker__errtext">{{ w.lastError }}</span>
            </span>
          </div>
        </div>

        <span class="hint"
          >Счётчики накопительные — за всё время жизни сервиса, а не за последний цикл.</span
        >
      </section>

      <section class="section section--gap">
        <h2 class="section__title">Обход</h2>
        <div v-if="crawl" class="crawl">
          <div class="crawl__cell">
            <span class="crawl__key mono">ДАТА СБОРА</span>
            <span class="crawl__value">{{ crawl.date }}</span>
            <span class="crawl__note mono">календарная дата UTC</span>
          </div>
          <div class="crawl__cell">
            <span class="crawl__key mono">ФАЗА</span>
            <span class="crawl__value">{{ crawl.phase }}</span>
            <span class="crawl__note mono">{{ PHASE_NOTE[crawl.phase] }}</span>
          </div>
          <div class="crawl__cell">
            <span class="crawl__key mono">СЛЕДУЮЩАЯ СТРАНИЦА</span>
            <span class="crawl__value">{{ crawl.nextPage }}</span>
            <span class="crawl__note mono">не чаще одного запроса в секунду</span>
          </div>
          <div class="crawl__cell">
            <span class="crawl__key mono">ОБРАБОТАНО ЗА ДЕНЬ</span>
            <span class="crawl__value">{{ crawl.processedToday }}</span>
            <span class="crawl__note mono">растёт на каждой игре</span>
          </div>
        </div>
        <div v-else class="empty">
          <span class="empty__note"
            >Обхода ещё не было — <span class="mono">crawl: null</span>. Дата, фаза и страница
            появятся после первого захода на Metacritic.</span
          >
        </div>
      </section>

      <section class="section section--gap">
        <div class="section__head">
          <h2 class="section__title">Журнал событий</h2>
          <span class="section__note">свежие сверху · хранится до 5000 записей</span>
        </div>

        <div v-if="!quietJournal" class="log" role="log" aria-label="Журнал событий" aria-live="polite">
          <div v-for="e in events" :key="e.id" class="log__row">
            <div class="log__line">
              <span class="log__time mono">{{ clockText(e.ts) }}</span>
              <span class="log__level mono" :class="`log__level--${e.level}`">{{
                e.level.toUpperCase()
              }}</span>
              <span class="log__worker mono">{{ e.worker }}</span>
              <span class="log__msg">{{ e.message }}</span>
              <button
                v-if="e.data !== null && e.data !== undefined"
                type="button"
                class="log__toggle mono"
                :aria-expanded="openIds.includes(e.id)"
                @click="toggleData(e.id)"
              >
                {{ openIds.includes(e.id) ? 'скрыть data' : 'data' }}
              </button>
            </div>
            <pre v-if="openIds.includes(e.id)" class="log__data noscroll">{{
              JSON.stringify(e.data, null, 2)
            }}</pre>
          </div>
        </div>

        <div v-else class="empty">
          <span class="empty__title">В журнале тихо</span>
          <span class="empty__note"
            >Между началом и концом обхода может пройти несколько минут без единой записи. Это не
            значит, что сервис встал: смотрите на «чем занят» и на счётчики выше — они меняются на
            каждой обработанной игре.</span
          >
        </div>
      </section>
    </template>

    <div v-else class="loading mono" role="status">подключаемся к потоку…</div>
  </div>
</template>

<style scoped>
.mon {
  padding: 0 0 80px;
}

.conn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 0 0;
}

.conn__dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

.conn__dot--live {
  background: var(--good);
  animation: pulse 2.4s ease-in-out infinite;
}

.conn__dot--off {
  background: var(--mixed);
  animation: pulse 0.9s ease-in-out infinite;
}

.conn__text {
  font-size: 11px;
  color: var(--good);
}

.conn__text--off {
  color: var(--mixed);
}

.offline {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-top: 16px;
  padding: 13px 15px;
  border-radius: var(--r-md);
  background: rgba(190, 150, 40, 0.08);
  border: 1px solid oklch(0.5 0.09 92);
}

.offline__badge {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.06em;
  padding: 3px 6px;
  border-radius: 4px;
  background: var(--mixed);
  color: #17130a;
}

.offline__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.offline__text {
  font-size: 13.5px;
  color: #ddc9a3;
  line-height: 1.55;
}

.offline__note {
  font-size: 10.5px;
  color: #a8916a;
}

.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 22px 0 0;
}

.cycle {
  display: flex;
  align-items: center;
  gap: 13px;
  flex: 1 1 320px;
  min-width: 0;
  padding: 15px 17px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  --dot: var(--muted-2);
}

.cycle--accent {
  --dot: var(--accent);
}

.cycle--warn {
  --dot: var(--mixed);
}

.cycle__dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--dot);
}

.cycle__dot--alive {
  animation: pulse 1.6s ease-in-out infinite;
}

.cycle__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cycle__title {
  font-size: 15px;
  font-weight: 600;
}

.cycle__note {
  font-size: 10.5px;
  color: #7d7d85;
  line-height: 1.5;
}

.run {
  flex: 1 1 220px;
  min-height: 46px;
  padding: 0 20px;
  border-radius: var(--r-md);
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--bg);
}

.run--off {
  border-color: var(--border-strong);
  background: var(--surface-2);
  color: var(--muted-2);
}

.outcome {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-top: 12px;
  padding: 12px 15px;
  border-radius: var(--r-md);
  background: #16161a;
  border: 1px solid var(--border-strong);
  --code: var(--text-3);
}

.outcome--accent {
  background: rgba(60, 150, 180, 0.09);
  border-color: oklch(0.45 0.08 205);
  --code: var(--accent);
}

.outcome--warn {
  background: rgba(190, 150, 40, 0.08);
  border-color: oklch(0.5 0.09 92);
  --code: var(--mixed);
}

.outcome__code {
  flex: none;
  font-size: 11px;
  font-weight: 700;
  color: var(--code);
}

.outcome__text {
  font-size: 13.5px;
  color: var(--text-2);
  line-height: 1.5;
}

.section--gap {
  padding: 34px 0 0;
}

.empty--fresh {
  margin-top: 26px;
  padding: 44px 22px;
  gap: 10px;
}

.empty--fresh .empty__title {
  font-size: 19px;
}

.empty__tech {
  font-size: 10.5px;
  color: var(--muted-3);
  margin-top: 4px;
}

.workers {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}

@media (min-width: 700px) {
  .workers {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 1060px) {
  .workers {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.worker {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 17px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  border-top: 2px solid var(--border-strong);
  --pill-bg: #22232a;
  --pill-fg: #9a9ba3;
}

/* Ошибка красит только свою карточку: остальные этапы отработали. */
.worker--running {
  border-top-color: var(--accent);
  --pill-bg: rgba(60, 150, 180, 0.14);
  --pill-fg: var(--accent);
}

.worker--error {
  border-top-color: var(--bad);
  --pill-bg: rgba(180, 60, 40, 0.14);
  --pill-fg: var(--bad-hi);
}

.worker__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.worker__name {
  font-size: 13px;
  font-weight: 700;
}

.worker__pill {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  padding: 4px 8px;
  border-radius: 5px;
  background: var(--pill-bg);
  color: var(--pill-fg);
}

.worker__pilldot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentcolor;
}

/* Движение — только там, где оно означает жизнь. */
.worker--running .worker__pilldot {
  animation: pulse 1.6s ease-in-out infinite;
}

.worker__now {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 52px;
}

.worker__role {
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--muted-2);
}

.worker__item {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  text-wrap: pretty;
  word-break: break-word;
}

.worker__item--idle {
  color: var(--muted-2);
  font-weight: 400;
}

.worker__counters {
  display: flex;
  gap: 10px;
}

.counter {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--surface-3);
  border-radius: 8px;
}

.counter__value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  color: var(--muted-2);
}

.counter:first-child .counter__value {
  color: var(--text);
}

.counter__value--warn {
  color: var(--mixed);
}

.counter__value--bad {
  color: var(--bad);
}

.counter__label {
  font-size: 9px;
  letter-spacing: 0.05em;
  color: var(--muted-2);
}

.worker__last {
  font-size: 10px;
  color: var(--muted-2);
}

.worker__err {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(180, 60, 40, 0.09);
  border: 1px solid oklch(0.42 0.1 25);
}

.worker__errlabel {
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--bad-hi);
}

.worker__errtext {
  font-size: 12.5px;
  color: #d8b6ae;
  line-height: 1.5;
  word-break: break-word;
}

.hint {
  font-size: 12.5px;
  color: var(--muted-2);
  line-height: 1.5;
}

.crawl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}

@media (min-width: 700px) {
  .crawl {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.crawl__cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 15px;
  background: var(--surface);
}

.crawl__key {
  font-size: 9.5px;
  letter-spacing: 0.05em;
  color: var(--muted-2);
}

.crawl__value {
  font-size: 15px;
  font-weight: 600;
}

.crawl__note {
  font-size: 10px;
  color: var(--muted-2);
  line-height: 1.5;
}

.log {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}

.log__row {
  display: flex;
  flex-direction: column;
  background: var(--surface);
}

.log__line {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  flex-wrap: wrap;
  padding: 11px 14px;
}

.log__time {
  flex: none;
  font-size: 10.5px;
  color: var(--muted-2);
  padding-top: 2px;
}

.log__level {
  flex: none;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  padding: 3px 7px;
  border-radius: 5px;
  background: #22232a;
  color: #9a9ba3;
}

.log__level--warn {
  background: rgba(190, 150, 40, 0.14);
  color: var(--mixed);
}

.log__level--error {
  background: rgba(180, 60, 40, 0.14);
  color: var(--bad-hi);
}

.log__worker {
  flex: none;
  font-size: 10.5px;
  color: #85858d;
  padding-top: 2px;
}

.log__msg {
  flex: 1 1 200px;
  min-width: 0;
  font-size: 13.5px;
  color: var(--text-2);
  line-height: 1.5;
  text-wrap: pretty;
}

.log__toggle {
  flex: none;
  min-height: 26px;
  padding: 0 9px;
  border-radius: var(--r-sm);
  border: 1px solid #33333a;
  background: #1c1c21;
  color: var(--text-3);
  font-size: 10px;
}

.log__toggle:hover {
  border-color: var(--accent);
}

.log__data {
  margin: 0 14px 13px;
  padding: 12px 13px;
  background: #101013;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  color: #a9c7d1;
  overflow-x: auto;
}

.loading {
  padding: 60px 0;
  font-size: 12px;
  color: var(--muted-2);
}
</style>
