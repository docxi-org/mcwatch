<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { ApiError, fetchGames, fetchPlatforms } from '../api/client.js';
import type { GameListItemDto, PlatformDto, SortKey } from '../api/types.js';
import GameTile from '../components/GameTile.vue';
import { countText, hoursSince, stampText } from '../lib/format.js';
import { saveList, takeList } from '../lib/listCache.js';
import {
  PAGE_SIZE,
  SORTS,
  filtersFromQuery,
  filtersKey,
  filtersToQuery,
  isDefaultFilters,
  sortNote,
  type ListFilters,
} from '../lib/listFilters.js';
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

/** Черновик поиска: в адрес он уезжает с задержкой, иначе история засоряется. */
const draft = ref('');
let draftTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;

const filters = computed<ListFilters>(() => filtersFromQuery(route.query));
const key = computed(() => filtersKey(filters.value));
const loadedAll = computed(() => items.value.length >= total.value);
const hasFilters = computed(() => !isDefaultFilters(filters.value));

const countLine = computed(() => {
  const shown = items.value.length;
  const all = total.value;
  const word = countText(all, 'игра', 'игры', 'игр');
  return shown >= all ? word : `показано ${shown} из ${all}`;
});

/**
 * Обход раз в час. Если последний удачный был больше суток назад, данные в
 * каталоге устарели, и молчать об этом нельзя.
 */
const staleHours = computed(() => {
  const hours = hoursSince(crawlerLastRun(status.value), Date.now());
  return hours !== null && hours >= 24 ? Math.round(hours) : null;
});
const staleStamp = computed(() => stampText(crawlerLastRun(status.value)));

async function loadPage(next: number, append: boolean): Promise<void> {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  loading.value = true;
  failure.value = null;
  try {
    const result = await fetchGames(
      { ...filters.value, page: next, pageSize: PAGE_SIZE },
      controller.signal,
    );
    items.value = append ? [...items.value, ...result.items] : result.items;
    total.value = result.total;
    page.value = result.page;
  } catch (err) {
    if (controller.signal.aborted) return;
    if (err instanceof ApiError && err.status === 400) {
      // Негодные параметры в адрес мог вписать только человек: чиним отбор
      // на умолчания и показываем список, а не экран ошибки.
      void router.replace({ name: 'list' });
      return;
    }
    failure.value = err instanceof ApiError ? err : new ApiError(0, 'неизвестный сбой');
  } finally {
    if (!controller.signal.aborted) {
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
  draft.value = filters.value.q ?? '';
  void fetchPlatforms()
    .then((list) => {
      platforms.value = list;
    })
    .catch(() => {
      // Без справочника платформ список всё равно работает — просто без чипов.
      platforms.value = [];
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
  if (draftTimer) clearTimeout(draftTimer);
});
</script>

<template>
  <div class="list">
    <div v-if="staleHours !== null" class="stale" role="status">
      <span class="stale__badge mono">{{ staleHours }} Ч</span>
      <span class="stale__text"
        >Последний удачный обход был {{ staleStamp }} UTC — больше суток назад. Сервис ходит на
        Metacritic раз в час, так что свежих релизов в списке может не хватать.</span
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
        все платформы
      </button>
      <button
        v-for="p in platforms"
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

    <!-- Сбой сервера. Отбор в адресе цел, поэтому «Обновить» вернёт то же. -->
    <div v-if="failure" class="failure">
      <span class="failure__code mono">{{ failure.status === 0 ? 'нет связи' : failure.status }}</span>
      <span class="failure__title">Сервис не ответил</span>
      <span class="failure__note"
        >С каталогом всё в порядке — не ответил сервер. Отбор сохранён, попробуйте ещё раз.</span
      >
      <button type="button" class="btn btn--primary" @click="reload">Обновить</button>
      <span class="failure__tech mono">{{ failure.message }}</span>
    </div>

    <template v-else>
      <div v-if="firstLoad" class="grid" aria-hidden="true">
        <div v-for="n in 10" :key="n" class="skeleton">
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
          <GameTile v-for="game in items" :key="game.slug" :game="game" />
        </div>

        <div ref="sentinel" class="sentinel" aria-hidden="true"></div>

        <div v-if="!loadedAll" class="more">
          <button type="button" class="btn" :disabled="loading" @click="loadMore">
            {{ loading ? 'загружаем…' : 'Показать ещё' }}
          </button>
        </div>
        <div v-else class="done mono">это все игры по текущему отбору</div>
      </template>

      <!-- Пусто по отбору и пусто в базе — разные вещи, и говорим о них разное. -->
      <div v-else-if="hasFilters" class="empty empty--big">
        <span class="empty__title">Ничего не нашлось</span>
        <span class="empty__note">
          <template v-if="filters.q">По запросу «{{ filters.q }}» </template>
          <template v-else>По выбранной платформе </template>
          в каталоге нет ни одной игры. Поиск идёт только по названию игры — не по разработчику,
          жанру или тексту отзывов.
        </span>
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

.sort {
  border: none;
  border-radius: var(--r-sm);
  min-height: 44px;
  padding: 0 13px;
  font-size: 12.5px;
  white-space: nowrap;
  background: transparent;
  color: var(--text-3);
}

.sort:hover {
  color: var(--text);
}

.sort--on {
  background: var(--accent);
  color: var(--bg);
  font-weight: 600;
}

.chips {
  display: flex;
  gap: 7px;
  overflow-x: auto;
  padding-bottom: 14px;
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
  color: var(--text-3);
  white-space: nowrap;
}

.chip:hover {
  border-color: var(--border-hover);
}

.chip--on {
  border-color: var(--accent);
  background: rgba(60, 150, 180, 0.14);
  color: var(--accent);
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
  color: var(--muted-2);
  padding: 4px 0 14px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

@media (min-width: 640px) {
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 900px) {
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
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
