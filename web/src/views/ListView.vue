<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import {
  ApiError,
  fetchFacets,
  fetchGames,
  fetchPlatforms,
  type FacetsDto,
} from '../api/client.js';
import type { GameListItemDto, PlatformDto, SortKey } from '../api/types.js';
import GameTile from '../components/GameTile.vue';
import { hoursSince, plural, stampHuman, stampText } from '../lib/format.js';
import { saveList, takeList } from '../lib/listCache.js';
import {
  MAX_PAGE_SIZE,
  PAGE_SIZE,
  SORTS,
  filtersFromQuery,
  filtersKey,
  filtersToQuery,
  isDefaultFilters,
  sortNote,
  type ListFilters,
} from '../lib/listFilters.js';
import { MIN_LOADING_MS, remainingMs } from '../lib/pacing.js';
import { FRESH_MS, POLL_MS, appearedSlugs } from '../lib/catalogWatch.js';
import { crawlerLastRun, useServiceStatus } from '../lib/serviceStatus.js';

/**
 * Список игр. Отбор целиком живёт в адресе, страницы подгружаются, при
 * возврате из карточки восстанавливаются и позиция, и уже загруженное
 * (`docs/UI-BRIEF.md` §3.1).
 */

const route = useRoute();
const router = useRouter();
const { status } = useServiceStatus();

const items = ref<GameListItemDto[]>([]);
const total = ref(0);
const page = ref(0);
const loading = ref(false);
const firstLoad = ref(true);
const failure = ref<ApiError | null>(null);
const platforms = ref<PlatformDto[]>([]);
/** Всего игр в базе — число для чипа «Все платформы», как в макете. */
const baseTotal = ref<number | null>(null);
const facets = ref<FacetsDto | null>(null);
/** Игры, появившиеся при обновлении: помечаются на несколько секунд. */
const freshSlugs = ref<Set<string>>(new Set());
let pollTimer: ReturnType<typeof setInterval> | null = null;
let freshTimer: ReturnType<typeof setTimeout> | null = null;

/** Черновик поиска: в адрес он уезжает с задержкой, иначе история засоряется. */
const draft = ref('');
let draftTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;

const filters = computed<ListFilters>(() => filtersFromQuery(route.query));
const key = computed(() => filtersKey(filters.value));
const loadedAll = computed(() => items.value.length >= total.value);
const hasFilters = computed(() => !isDefaultFilters(filters.value));

const countLine = computed(() => {
  const all = total.value;
  const shown = Math.min(items.value.length, all);
  return `${all} ${plural(all, 'игра', 'игры', 'игр')} по отбору · показано ${shown}`;
});

/** Чипы платформ идут по числу игр, а не по алфавиту (макет). */
const platformChips = computed(() =>
  [...platforms.value].sort((a, b) => b.gameCount - a.gameCount),
);

const emptyTitle = computed(() =>
  filters.value.q ? `По запросу «${filters.value.q}» ничего не нашлось` : 'Под этот отбор игр нет',
);

/** Объяснение подбирается под то, чем именно отбор сузили. */
const emptyNote = computed(() => {
  if (filters.value.q) {
    return 'Поиск идёт только по названию игры и не учитывает описания. Проверьте раскладку или снимите фильтр по платформе.';
  }
  if (filters.value.letsplay && filters.value.trailer) {
    return 'Игр, у которых есть и заключение о летсплее, и трейлер, в базе нет. Снимите один из двух фильтров.';
  }
  if (filters.value.letsplay) {
    return 'Заключение о летсплее есть не у всех игр: для многих релизов на YouTube просто нет прохождения, а найденные ролики оказываются про другую игру.';
  }
  if (filters.value.trailer) {
    return 'Трейлер Metacritic публикует редко — примерно у одной игры из десяти.';
  }
  return 'Попробуйте выбрать другую платформу.';
});

const moreText = computed(
  () => `Показать ещё ${Math.min(PAGE_SIZE, Math.max(0, total.value - items.value.length))}`,
);

/**
 * Обход раз в час. Если последний удачный был больше суток назад, данные в
 * каталоге устарели, и молчать об этом нельзя.
 */
const staleHours = computed(() => {
  const hours = hoursSince(crawlerLastRun(status.value), Date.now());
  return hours !== null && hours >= 24 ? Math.round(hours) : null;
});
const staleStamp = computed(() =>
  status.value === null ? 'неизвестно' : stampText(crawlerLastRun(status.value)),
);
const staleWhen = computed(() => stampHuman(crawlerLastRun(status.value)));
const hoursWord = computed(() => plural(staleHours.value ?? 0, 'час', 'часа', 'часов'));

/** Дожидается, пока заглушки отработают минимум (`MIN_LOADING_MS`). */
function holdSkeletons(startedAt: number): Promise<void> {
  const left = remainingMs(startedAt, performance.now(), MIN_LOADING_MS);
  return left === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, left));
}

async function loadPage(next: number, append: boolean): Promise<void> {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  loading.value = true;
  failure.value = null;
  // Монотонные часы: перевод системного времени не должен влиять на показ.
  const startedAt = performance.now();
  // Функцией, а не полем: между `await` запрос успевает быть отменённым, и
  // сужение типа по прошлой проверке тут врало бы.
  const cancelled = (): boolean => controller.signal.aborted;

  try {
    const result = await fetchGames(
      { ...filters.value, page: next, pageSize: PAGE_SIZE },
      controller.signal,
    );
    if (cancelled()) return;
    await holdSkeletons(startedAt);
    if (cancelled()) return;
    items.value = append ? [...items.value, ...result.items] : result.items;
    total.value = result.total;
    page.value = result.page;
  } catch (err) {
    if (cancelled()) return;
    if (err instanceof ApiError && err.status === 400) {
      // Негодные параметры в адрес мог вписать только человек: чиним отбор
      // на умолчания и показываем список, а не экран ошибки.
      void router.replace({ name: 'list' });
      return;
    }
    // Экран сбоя тоже не должен выскакивать поверх мигнувших заглушек.
    await holdSkeletons(startedAt);
    if (cancelled()) return;
    failure.value = err instanceof ApiError ? err : new ApiError(0, 'неизвестный сбой');
  } finally {
    if (!cancelled()) {
      loading.value = false;
      firstLoad.value = false;
    }
  }
}

function reload(): void {
  items.value = [];
  total.value = 0;
  page.value = 0;
  firstLoad.value = true;
  void loadPage(1, false);
}

function loadMore(): void {
  if (loading.value || loadedAll.value) return;
  void loadPage(page.value + 1, true);
}

function applyFilters(patch: Partial<ListFilters>): void {
  void router.push({ name: 'list', query: filtersToQuery({ ...filters.value, ...patch }) });
}

function pickSort(sort: SortKey): void {
  applyFilters({ sort });
}

function pickPlatform(platform: string | null): void {
  applyFilters({ platform });
}

/** Дополнительные фильтры складываются друг с другом и с платформой. */
function toggleLetsplay(): void {
  applyFilters({ letsplay: !filters.value.letsplay });
}

function toggleTrailer(): void {
  applyFilters({ trailer: !filters.value.trailer });
}

function onSearch(event: Event): void {
  draft.value = (event.target as HTMLInputElement).value;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const value = draft.value.trim();
    applyFilters({ q: value.length > 0 ? value : null });
  }, 350);
}

function resetFilters(): void {
  draft.value = '';
  void router.push({ name: 'list' });
}

/**
 * Сколько колонок в сетке сейчас. Нужно только заглушкам: в макете их ровно
 * два ряда на первой загрузке и один ряд на догрузке, а «десять всегда» на
 * телефоне давало пять экранов пустых плиток.
 */
const cols = ref(2);

function syncCols(): void {
  cols.value = window.matchMedia('(min-width: 1120px)').matches
    ? 5
    : window.matchMedia('(min-width: 640px)').matches
      ? 3
      : 2;
}

// ── Обновление на месте ────────────────────────────────────────────────────

/**
 * Тихое обновление уже загруженного. Список отрисован по ключу `slug`, и
 * замена массива не пересоздаёт карточки: те же узлы DOM, обложки не моргают,
 * наведение не слетает. Вставку выше видимой области браузер компенсирует
 * якорением прокрутки — читающий человек остаётся на том же месте.
 */
async function poll(): Promise<void> {
  if (document.hidden || loading.value || items.value.length === 0) return;

  try {
    // Спрашиваем ровно столько, сколько уже показано, одним запросом.
    const size = Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, items.value.length));
    const [result, f] = await Promise.all([
      fetchGames({ ...filters.value, page: 1, pageSize: size }),
      fetchFacets(),
    ]);

    const appeared = appearedSlugs(items.value, result.items);

    items.value = result.items;
    total.value = result.total;
    page.value = Math.max(1, Math.ceil(result.items.length / PAGE_SIZE));
    facets.value = f;

    if (appeared.length > 0) markFresh(appeared);
  } catch {
    // Не достучались — молчим: страница уже показывает то, что показывала.
  }
}

function markFresh(slugs: string[]): void {
  freshSlugs.value = new Set([...freshSlugs.value, ...slugs]);
  if (freshTimer) clearTimeout(freshTimer);
  freshTimer = setTimeout(() => {
    freshSlugs.value = new Set();
  }, FRESH_MS);
}

/** Возврат на вкладку — момент, когда человек заведомо не читает. */
function onVisible(): void {
  if (!document.hidden) void poll();
}

// ── Подгрузка при прокрутке ────────────────────────────────────────────────

const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

function watchSentinel(): void {
  observer?.disconnect();
  const el = sentinel.value;
  if (!el || typeof IntersectionObserver === 'undefined') return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    },
    // Дотягиваем следующую страницу заранее, за 400 px до конца.
    { rootMargin: '400px 0px' },
  );
  observer.observe(el);
}

watch(sentinel, watchSentinel);

// ── Жизненный цикл ─────────────────────────────────────────────────────────

onMounted(() => {
  syncCols();
  window.addEventListener('resize', syncCols);
  document.addEventListener('visibilitychange', onVisible);
  pollTimer = setInterval(() => void poll(), POLL_MS);
  draft.value = filters.value.q ?? '';
  void fetchPlatforms()
    .then((list) => {
      platforms.value = list;
    })
    .catch(() => {
      // Без справочника платформ список всё равно работает — просто без чипов.
      platforms.value = [];
    });

  // Отдельный лёгкий запрос: счётчик на чипе «Все платформы» — это число игр
  // в базе, а сумма по платформам его не даёт (игра стоит на нескольких).
  void fetchFacets()
    .then((f) => {
      facets.value = f;
    })
    .catch(() => {
      facets.value = null;
    });

  void fetchGames({
    platform: null,
    q: null,
    sort: 'title',
    letsplay: false,
    trailer: false,
    page: 1,
    pageSize: 1,
  })
    .then((result) => {
      baseTotal.value = result.total;
    })
    .catch(() => {
      baseTotal.value = null;
    });

  const restored = takeList(key.value);
  if (restored) {
    items.value = restored.items;
    total.value = restored.total;
    page.value = restored.page;
    firstLoad.value = false;
    requestAnimationFrame(() => {
      window.scrollTo(0, restored.scrollY);
    });
    return;
  }
  reload();
});

watch(key, (next, prev) => {
  if (next === prev) return;
  draft.value = filters.value.q ?? '';
  window.scrollTo(0, 0);
  reload();
});

onBeforeRouteLeave((to) => {
  // Уходим в карточку — запоминаем список целиком; в остальных случаях нет.
  if (to.name === 'game') {
    saveList({
      key: key.value,
      items: items.value,
      total: total.value,
      page: page.value,
      scrollY: window.scrollY,
    });
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  inFlight?.abort();
  window.removeEventListener('resize', syncCols);
  document.removeEventListener('visibilitychange', onVisible);
  if (pollTimer) clearInterval(pollTimer);
  if (freshTimer) clearTimeout(freshTimer);
  if (draftTimer) clearTimeout(draftTimer);
});
</script>

<template>
  <div class="list">
    <div v-if="staleHours !== null" class="stale" role="status">
      <span class="stale__badge mono">{{ staleHours }} Ч</span>
      <span class="stale__text"
        >Последний удачный обход — {{ staleWhen }} UTC, {{ staleHours }}
        {{ hoursWord }} назад. Свежие релизы Metacritic могут в каталоге ещё не появиться.</span
      >
    </div>

    <div class="controls">
      <div class="controls__search">
        <input
          type="search"
          class="controls__input"
          aria-label="Поиск игры по названию"
          placeholder="поиск по названию"
          :value="draft"
          @input="onSearch"
        />
      </div>
      <div class="controls__sorts noscroll" role="group" aria-label="Сортировка списка">
        <button
          v-for="s in SORTS"
          :key="s.key"
          type="button"
          class="sort"
          :class="{ 'sort--on': filters.sort === s.key }"
          :aria-pressed="filters.sort === s.key"
          @click="pickSort(s.key)"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <div v-if="platforms.length > 0" class="chips noscroll" role="group" aria-label="Фильтр по платформе">
      <button
        type="button"
        class="chip"
        :class="{ 'chip--on': filters.platform === null }"
        :aria-pressed="filters.platform === null"
        @click="pickPlatform(null)"
      >
        Все платформы<span v-if="baseTotal !== null" class="chip__count mono">{{
          baseTotal
        }}</span>
      </button>
      <button
        v-for="p in platformChips"
        :key="p.platform"
        type="button"
        class="chip"
        :class="{ 'chip--on': filters.platform === p.platform }"
        :aria-pressed="filters.platform === p.platform"
        @click="pickPlatform(p.platform)"
      >
        {{ p.platform }}<span class="chip__count mono">{{ p.gameCount }}</span>
      </button>
    </div>

    <!--
      Дополнительные фильтры складываются друг с другом, поэтому это
      переключатели с `aria-pressed`, а не выбор одного из списка.
    -->
    <div v-if="facets" class="chips noscroll" role="group" aria-label="Дополнительные фильтры">
      <span class="chips__label mono">ТОЛЬКО</span>
      <button
        type="button"
        class="chip"
        :class="{ 'chip--on': filters.letsplay }"
        :aria-pressed="filters.letsplay"
        @click="toggleLetsplay"
      >
        с летсплеем<span class="chip__count mono">{{ facets.withLetsplay }}</span>
      </button>
      <button
        type="button"
        class="chip"
        :class="{ 'chip--on': filters.trailer }"
        :aria-pressed="filters.trailer"
        @click="toggleTrailer"
      >
        с трейлером<span class="chip__count mono">{{ facets.withTrailer }}</span>
      </button>
    </div>

    <!-- Сбой сервера. Отбор в адресе цел, поэтому «Обновить» вернёт то же. -->
    <div v-if="failure" class="failure">
      <span class="failure__code mono">{{ failure.status === 0 ? 'нет связи' : failure.status }}</span>
      <span class="failure__title">Сервис не ответил</span>
      <span class="failure__note"
        >Сбой на нашей стороне, с каталогом всё в порядке. Обычно проходит за минуту — попробуйте
        обновить страницу.</span
      >
      <button type="button" class="btn btn--primary" @click="reload">Обновить</button>
      <span class="failure__tech mono">GET /api/games → {{ failure.message }}</span>
    </div>

    <template v-else>
      <div v-if="firstLoad" class="grid" aria-hidden="true">
        <div v-for="n in cols * 2" :key="n" class="skeleton">
          <div class="skeleton__cover"></div>
          <div class="skeleton__body">
            <span class="skeleton__line skeleton__line--wide"></span>
            <span class="skeleton__line"></span>
            <span class="skeleton__line skeleton__line--short"></span>
            <span class="skeleton__box"></span>
          </div>
        </div>
      </div>

      <template v-else-if="items.length > 0">
        <div class="counters mono">
          <span>{{ countLine }}</span>
          <span>{{ sortNote(filters.sort) }}</span>
        </div>

        <div class="grid">
          <GameTile
            v-for="game in items"
            :key="game.slug"
            :game="game"
            :fresh="freshSlugs.has(game.slug)"
          />
          <!--
            Догрузка обязана быть видимой: ряд заглушек говорит, что страница
            уже едет, — иначе карточки появляются молча (макет, `skelCount`).
          -->
          <div
            v-for="n in loading ? cols : 0"
            :key="`skeleton-${n}`"
            class="skeleton"
            aria-hidden="true"
          >
            <div class="skeleton__cover"></div>
            <div class="skeleton__body">
              <span class="skeleton__line skeleton__line--wide"></span>
              <span class="skeleton__line"></span>
              <span class="skeleton__line skeleton__line--short"></span>
              <span class="skeleton__box"></span>
            </div>
          </div>
        </div>

        <div ref="sentinel" class="sentinel" aria-hidden="true"></div>

        <div v-if="!loadedAll && !loading" class="more">
          <button type="button" class="btn" @click="loadMore">{{ moreText }}</button>
        </div>
        <div v-else-if="loadedAll" class="done mono">это все игры по текущему отбору</div>
      </template>

      <!-- Пусто по отбору и пусто в базе — разные вещи, и говорим о них разное. -->
      <div v-else-if="hasFilters" class="empty empty--big">
        <span class="empty__title">{{ emptyTitle }}</span>
        <span class="empty__note">{{ emptyNote }}</span>
        <button type="button" class="btn" @click="resetFilters">Сбросить отбор</button>
      </div>

      <div v-else class="empty empty--big">
        <span class="empty__title">База пока пуста</span>
        <span class="empty__note"
          >Сервис обходит Metacritic раз в час. Первые игры появятся в каталоге сразу после
          удачного обхода.</span
        >
        <span class="empty__stamp mono">последний обход: {{ staleStamp }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.list {
  padding-bottom: 80px;
}

.stale {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin: 20px 0 0;
  padding: 13px 15px;
  border-radius: var(--r-md);
  background: rgba(190, 150, 40, 0.08);
  border: 1px solid oklch(0.5 0.09 92);
}

.stale__badge {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.06em;
  padding: 3px 6px;
  border-radius: 4px;
  background: var(--mixed);
  color: #17130a;
}

.stale__text {
  font-size: 13.5px;
  color: #ddc9a3;
  line-height: 1.55;
  text-wrap: pretty;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 20px 0 14px;
}

.controls__search {
  flex: 1 1 240px;
  min-width: 0;
}

.controls__input {
  width: 100%;
  background: #151518;
  border: 1px solid #2a2a30;
  border-radius: 8px;
  padding: 11px 13px;
  color: var(--text);
  font-size: 14px;
  outline: none;
}

.controls__input:focus {
  border-color: var(--accent);
}

.controls__sorts {
  display: flex;
  gap: 4px;
  padding: 3px;
  max-width: 100%;
  overflow-x: auto;
  background: #151518;
  border: 1px solid #2a2a30;
  border-radius: 8px;
}

/*
 * Акцентом залит выбранный чип платформы, а сортировка — приглушённая
 * плашка. Так в макете: два ярких пятна на одном экране спорили бы.
 */
.sort {
  border: none;
  border-radius: var(--r-sm);
  min-height: 44px;
  padding: 0 13px;
  font-size: 12.5px;
  white-space: nowrap;
  background: transparent;
  color: var(--muted);
}

.sort:hover {
  color: var(--text);
}

.sort--on {
  background: #2a2a31;
  color: #f2f3f5;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  padding-bottom: 14px;
}

/*
 * Перенос, а не прокрутка: платформ стало больше десятка, и половина
 * уезжала за край незамеченной. На узком экране перенос съел бы пол-экрана,
 * поэтому там остаётся горизонтальная прокрутка — как и требует спека.
 */
@media (max-width: 639px) {
  .chips {
    flex-wrap: nowrap;
    overflow-x: auto;
  }
}

.chips__label {
  flex: none;
  align-self: center;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--muted-2);
  padding-right: 2px;
}

.chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  border-radius: 999px;
  min-height: 44px;
  padding: 0 16px;
  font-size: 13px;
  border: 1px solid #2a2a30;
  background: #151518;
  color: #c6c7cd;
  white-space: nowrap;
}

.chip:hover {
  border-color: var(--border-hover);
}

.chip--on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--bg);
}

.chip__count {
  font-size: 10.5px;
  opacity: 0.65;
}

.counters {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: #6f6f77;
  padding: 4px 0 14px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

/* Три ширины макета: 390 → 2, 834 → 3, 1280 → 5. Промежуточных нет. */
@media (min-width: 640px) {
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 1120px) {
  .grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

.sentinel {
  height: 1px;
}

.more {
  display: flex;
  justify-content: center;
  padding: 28px 0 0;
}

.done {
  text-align: center;
  font-size: 11px;
  color: var(--muted-3);
  padding: 34px 0 0;
}

.empty--big {
  align-items: center;
  text-align: center;
  padding: 84px 20px;
  gap: 12px;
  margin-top: 8px;
}

.empty--big .empty__title {
  font-size: 19px;
}

.empty--big .empty__note {
  max-width: 460px;
}

.empty__stamp {
  font-size: 11px;
  color: var(--muted-3);
}

.failure {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 64px 0 40px;
  max-width: 560px;
}

.failure__code {
  font-size: 46px;
  font-weight: 700;
  line-height: 1;
  color: #2f2f36;
}

.failure__title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.failure__note {
  font-size: 14.5px;
  color: var(--muted);
  line-height: 1.6;
}

.failure__tech {
  font-size: 10.5px;
  color: var(--muted-3);
  padding: 8px 11px;
  background: #131316;
  border: 1px solid var(--border);
  border-radius: 7px;
  word-break: break-word;
}

.skeleton {
  display: flex;
  flex-direction: column;
  background: #121215;
  border: 1px solid #1e1e22;
  border-radius: var(--r-lg);
  overflow: hidden;
}

.skeleton__cover {
  aspect-ratio: 3 / 4;
  background: linear-gradient(100deg, #17171b 30%, #202027 50%, #17171b 70%);
  background-size: 300% 100%;
  animation: shine 1.3s linear infinite;
}

.skeleton__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 13px;
}

.skeleton__line {
  height: 9px;
  width: 55%;
  border-radius: 4px;
  background: #1a1a1e;
}

.skeleton__line--wide {
  height: 12px;
  width: 80%;
  background: #1e1e23;
}

.skeleton__line--short {
  width: 40%;
}

.skeleton__box {
  height: 34px;
  width: 90px;
  border-radius: var(--r-sm);
  background: #1a1a1e;
  margin-top: 6px;
}
</style>
