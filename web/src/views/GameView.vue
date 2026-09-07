<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ApiError, fetchGame } from '../api/client.js';
import type { GameCardDto } from '../api/types.js';
import CoverArt from '../components/CoverArt.vue';
import LetsplayBlock from '../components/LetsplayBlock.vue';
import PlatformScores from '../components/PlatformScores.vue';
import ScoreBadge from '../components/ScoreBadge.vue';
import SimilarGames from '../components/SimilarGames.vue';
import SummaryCard from '../components/SummaryCard.vue';
import TrailerDialog from '../components/TrailerDialog.vue';
import { countText, dateText } from '../lib/format.js';

/**
 * Карточка игры. Показывает всё, что требует ТЗ, и честно объясняет каждую
 * дыру в данных: неполные карточки — норма, а не сбой (`docs/UI-BRIEF.md` §5).
 */
const props = defineProps<{ slug: string }>();

const game = ref<GameCardDto | null>(null);
const loading = ref(true);
const failure = ref<ApiError | null>(null);
const videoOpen = ref(false);
let inFlight: AbortController | null = null;

async function load(slug: string): Promise<void> {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  loading.value = true;
  failure.value = null;
  videoOpen.value = false;
  try {
    game.value = await fetchGame(slug, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return;
    game.value = null;
    failure.value = err instanceof ApiError ? err : new ApiError(0, 'неизвестный сбой');
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

watch(
  () => props.slug,
  (slug) => {
    window.scrollTo(0, 0);
    void load(slug);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  inFlight?.abort();
});

/** Факты, которых нет, строкой не занимают места — ESRB нет у 70% игр. */
const facts = computed(() => {
  const g = game.value;
  if (!g) return [];
  const rows = [
    { k: 'РАЗРАБОТЧИК', v: g.developer ?? 'не указан' },
    { k: 'ИЗДАТЕЛЬ', v: g.publisher ?? 'не указан' },
    { k: 'ДАТА ВЫХОДА', v: dateText(g.releaseDate) },
  ];
  if (g.esrb) rows.push({ k: 'РЕЙТИНГ ESRB', v: g.esrb });
  return rows;
});

/** Лучшие значения среди платформ: в самой карточке они уже посчитаны. */
const best = computed(() => {
  const rows = game.value?.platforms ?? [];
  const metascores = rows.map((r) => r.metascore).filter((v): v is number => v !== null);
  const userscores = rows.map((r) => r.userscore).filter((v): v is number => v !== null);
  return {
    metascore: metascores.length > 0 ? Math.max(...metascores) : null,
    userscore: userscores.length > 0 ? Math.max(...userscores) : null,
    platformCount: rows.length,
  };
});

const criticNote = computed(() =>
  best.value.metascore === null
    ? 'ни одна платформа не оценена'
    : `лучшее из ${countText(best.value.platformCount, 'платформы', 'платформ', 'платформ')}`,
);

const userNote = computed(() =>
  best.value.userscore === null
    ? 'игроки ещё не оценивали'
    : `лучшее из ${countText(best.value.platformCount, 'платформы', 'платформ', 'платформ')}`,
);

const hasAnySummary = computed(
  () => Boolean(game.value?.summaries.critic) || Boolean(game.value?.summaries.user),
);
</script>

<template>
  <div class="game">
    <RouterLink class="back mono" :to="{ name: 'list' }">← ко всем играм</RouterLink>

    <div v-if="loading" class="loading mono" role="status">загружаем карточку…</div>

    <!-- 404 — не пустая карточка, а свой экран с выходом обратно в каталог. -->
    <div v-else-if="failure?.status === 404" class="fail">
      <span class="fail__code mono">404</span>
      <span class="fail__title">Такой игры в каталоге нет</span>
      <span class="fail__note"
        >В базе только то, что сервис успел собрать: он обходит Metacritic раз в час и берёт новые
        релизы. Возможно, эта игра ещё не попала в обход или ссылка устарела.</span
      >
      <RouterLink class="btn btn--primary fail__btn" :to="{ name: 'list' }"
        >Ко всем играм</RouterLink
      >
    </div>

    <div v-else-if="failure" class="fail">
      <span class="fail__code mono">{{ failure.status === 0 ? 'нет связи' : failure.status }}</span>
      <span class="fail__title">Сервис не ответил</span>
      <span class="fail__note"
        >С каталогом всё в порядке — не ответил сервер. Попробуйте открыть карточку ещё раз.</span
      >
      <button type="button" class="btn btn--primary fail__btn" @click="load(props.slug)">
        Обновить
      </button>
      <span class="fail__tech mono">{{ failure.message }}</span>
    </div>

    <template v-else-if="game">
      <div v-if="game.status === 'failed'" class="warn" role="status">
        <span class="warn__badge mono">FAILED</span>
        <span class="warn__text"
          >Последний обход этой игры не удался — часть данных может быть устаревшей или
          отсутствовать.</span
        >
      </div>

      <div class="layout">
        <aside class="side">
          <CoverArt :src="game.coverUrl" :title="game.title" size="card" />

          <div class="facts">
            <div v-for="fact in facts" :key="fact.k" class="facts__row">
              <span class="facts__key mono">{{ fact.k }}</span>
              <span class="facts__value">{{ fact.v }}</span>
            </div>
          </div>

          <div v-if="game.videoUrl" class="trailer">
            <button
              type="button"
              class="trailer__btn hatch"
              aria-label="Смотреть трейлер"
              @click="videoOpen = true"
            >
              <span class="trailer__play" aria-hidden="true"></span>
            </button>
            <span class="trailer__note mono">трейлер · откроется в модальном окне</span>
          </div>
        </aside>

        <div class="main">
          <div class="head">
            <h1 class="head__title">{{ game.title }}</h1>

            <div v-if="game.genres.length > 0" class="head__genres">
              <span v-for="genre in game.genres" :key="genre" class="head__genre">{{ genre }}</span>
            </div>
            <span v-else class="head__nogenres mono">жанры Metacritic не указал</span>

            <div class="hero">
              <div class="hero__card">
                <ScoreBadge kind="critic" :value="best.metascore" size="lg" />
                <span class="hero__meta">
                  <span class="hero__name">Критики</span>
                  <span class="hero__note mono">метаскор · шкала 0–100</span>
                  <span class="hero__note mono">{{ criticNote }}</span>
                </span>
              </div>
              <div class="hero__card">
                <ScoreBadge kind="user" :value="best.userscore" size="lg" />
                <span class="hero__meta">
                  <span class="hero__name">Игроки</span>
                  <span class="hero__note mono">оценка игроков · шкала 0–10</span>
                  <span class="hero__note mono">{{ userNote }}</span>
                </span>
              </div>
            </div>
            <span class="head__scalenote mono"
              >лучшие значения среди платформ · по каждой платформе оценки свои</span
            >
          </div>

          <p v-if="game.description" class="desc">{{ game.description }}</p>
          <div v-else class="desc__none">
            <span>Описание Metacritic не публикует</span>
          </div>

          <PlatformScores :rows="game.platforms" />

          <section class="section">
            <h2 class="section__title">Что пишут в отзывах</h2>
            <div v-if="hasAnySummary" class="summaries">
              <SummaryCard
                kind="critic"
                :summary="game.summaries.critic"
                :review-count="game.reviewCounts.critic"
              />
              <SummaryCard
                kind="user"
                :summary="game.summaries.user"
                :review-count="game.reviewCounts.user"
              />
            </div>
            <div v-else class="empty">
              <span class="empty__title">Отзывов пока нет</span>
              <span class="empty__note"
                >Ни критики, ни игроки ещё не написали ни одного отзыва — резюмировать нечего.
                Обычная ситуация для игры, вышедшей несколько дней назад.</span
              >
            </div>
          </section>

          <LetsplayBlock :letsplay="game.letsplay" />

          <SimilarGames :games="game.similar" />
        </div>
      </div>

      <TrailerDialog
        v-if="videoOpen && game.videoUrl"
        :title="game.title"
        :url="game.videoUrl"
        @close="videoOpen = false"
      />
    </template>
  </div>
</template>

<style scoped>
.game {
  padding: 20px 0 80px;
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
  font-size: 11.5px;
  color: var(--muted);
}

.back:hover {
  color: var(--accent-hi);
}

.loading {
  padding: 80px 0;
  font-size: 12px;
  color: var(--muted-2);
}

.warn {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  padding: 12px 14px;
  margin-bottom: 20px;
  border-radius: var(--r-md);
  background: rgba(180, 60, 40, 0.09);
  border: 1px solid oklch(0.45 0.11 25);
}

.warn__badge {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.06em;
  padding: 3px 6px;
  border-radius: 4px;
  background: oklch(0.62 0.2 25);
  color: #17070a;
}

.warn__text {
  font-size: 13px;
  color: #d8b6ae;
  line-height: 1.5;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 28px;
  align-items: start;
}

@media (min-width: 820px) {
  .layout {
    grid-template-columns: 300px minmax(0, 1fr);
  }
}

.side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

@media (min-width: 820px) {
  .side {
    position: sticky;
    top: 16px;
  }
}

.facts {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}

.facts__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 13px;
  background: var(--surface);
}

.facts__key {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--muted-2);
  flex: none;
}

.facts__value {
  font-size: 12.5px;
  color: var(--text-2);
  text-align: right;
}

.trailer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trailer__btn {
  position: relative;
  aspect-ratio: 16 / 9;
  width: 100%;
  background-color: #1b1b20;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  display: grid;
  place-items: center;
}

.trailer__btn:hover {
  border-color: var(--accent);
}

.trailer__play {
  display: block;
  width: 0;
  height: 0;
  border-left: 14px solid #e6e7ea;
  border-top: 9px solid transparent;
  border-bottom: 9px solid transparent;
  margin-left: 4px;
}

.trailer__note {
  font-size: 10px;
  color: var(--muted-2);
}

.main {
  display: flex;
  flex-direction: column;
  gap: 30px;
  min-width: 0;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.head__title {
  font-size: 27px;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.1;
  text-wrap: pretty;
}

@media (min-width: 820px) {
  .head__title {
    font-size: 34px;
  }
}

.head__genres {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.head__genre {
  font-size: 12px;
  color: var(--text-3);
  background: #1e1e23;
  border-radius: var(--r-sm);
  padding: 5px 9px;
}

.head__nogenres {
  font-size: 11px;
  color: #64646c;
}

.head__scalenote {
  font-size: 10px;
  color: var(--muted-3);
}

.hero {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 4px;
}

.hero__card {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 13px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}

.hero__meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hero__name {
  font-size: 13px;
  font-weight: 600;
}

.hero__note {
  font-size: 10px;
  color: var(--muted-2);
}

.desc {
  font-size: 15px;
  line-height: 1.65;
  color: #c8c9cf;
  max-width: 62ch;
  text-wrap: pretty;
}

.desc__none {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 15px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  font-size: 13.5px;
  color: var(--muted);
}

.summaries {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}

@media (min-width: 1000px) {
  .summaries {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.fail {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  max-width: 560px;
  padding: 80px 0 40px;
}

.fail__code {
  font-size: 54px;
  font-weight: 700;
  line-height: 1;
  color: #2f2f36;
  letter-spacing: -0.02em;
}

.fail__title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.fail__note {
  font-size: 14.5px;
  color: var(--muted);
  line-height: 1.6;
  text-wrap: pretty;
}

.fail__btn {
  display: inline-flex;
  align-items: center;
  margin-top: 6px;
}

.fail__tech {
  font-size: 10.5px;
  color: var(--muted-3);
  padding: 8px 11px;
  background: #131316;
  border: 1px solid var(--border);
  border-radius: 7px;
  word-break: break-word;
}
</style>
