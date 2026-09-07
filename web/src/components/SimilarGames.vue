<script setup lang="ts">
import type { SimilarGameDto } from '../api/types.js';
import CoverArt from './CoverArt.vue';
import ScoreBadge from './ScoreBadge.vue';

/**
 * Похожие игры. Пустой блок объясняет себя: подставлять случайные игры вместо
 * похожих нельзя (`docs/UI-BRIEF.md` §5). Поле `score` служебное и не
 * показывается.
 */
defineProps<{ games: SimilarGameDto[] }>();
</script>

<template>
  <section class="section">
    <h2 class="section__title">Похожие игры</h2>

    <div v-if="games.length > 0" class="similar">
      <RouterLink
        v-for="game in games"
        :key="game.slug"
        class="similar__item"
        :to="{ name: 'game', params: { slug: game.slug } }"
        :aria-label="`Открыть карточку игры ${game.title}`"
      >
        <CoverArt :src="game.coverUrl" :title="game.title" size="mini" />
        <div class="similar__body">
          <span class="similar__title">{{ game.title }}</span>
          <span class="similar__score">
            <ScoreBadge
              v-if="game.bestMetascore !== null"
              kind="critic"
              :value="game.bestMetascore"
              size="xs"
              :bar="false"
            />
            <span class="similar__note mono">{{
              game.bestMetascore === null ? 'нет метаскора' : 'метаскор'
            }}</span>
          </span>
        </div>
      </RouterLink>
    </div>

    <div v-else class="empty">
      <span class="empty__title">Похожих игр не нашлось</span>
      <span class="empty__note"
        >В базе нет игр, достаточно близких по описанию, жанрам и платформам. Случайные игры вместо
        похожих мы не подставляем.</span
      >
    </div>
  </section>
</template>

<style scoped>
.similar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

/* Макет: 2 колонки на мобильном, 4 на планшете и десктопе. */
@media (min-width: 640px) {
  .similar {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.similar__item {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  color: inherit;
}

.similar__item:hover {
  border-color: var(--border-hover);
  color: inherit;
}

.similar__body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 11px 12px;
}

.similar__title {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.35;
  text-wrap: pretty;
}

.similar__score {
  display: flex;
  align-items: center;
  gap: 6px;
}

.similar__note {
  font-size: 9px;
  color: var(--muted-3);
}
</style>
