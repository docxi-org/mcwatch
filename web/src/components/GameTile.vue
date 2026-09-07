<script setup lang="ts">
import { computed } from 'vue';
import type { GameListItemDto } from '../api/types.js';
import { dateText } from '../lib/format.js';
import CoverArt from './CoverArt.vue';
import ScoreBadge from './ScoreBadge.vue';

/**
 * Плитка списка. Это ссылка, а не блок с обработчиком: клавиатура, средний
 * клик и «открыть в новой вкладке» тогда достаются бесплатно.
 */
const props = defineProps<{ game: GameListItemDto }>();

const platformsText = computed(() =>
  props.game.platforms.length > 0 ? props.game.platforms.join(' · ') : 'платформы не указаны',
);
</script>

<template>
  <RouterLink
    class="tile"
    :to="{ name: 'game', params: { slug: props.game.slug } }"
    :aria-label="`Открыть карточку игры ${props.game.title}`"
  >
    <div class="tile__cover">
      <CoverArt :src="props.game.coverUrl" :title="props.game.title" size="tile" />
      <span v-if="props.game.status === 'failed'" class="tile__failed">ДАННЫЕ НЕПОЛНЫЕ</span>
    </div>

    <div class="tile__body">
      <span class="tile__title">{{ props.game.title }}</span>

      <span class="tile__meta">
        <span>{{ dateText(props.game.releaseDate) }}</span>
        <span>{{ props.game.developer ?? 'разработчик не указан' }}</span>
      </span>

      <div v-if="props.game.genres.length > 0" class="tile__genres">
        <span v-for="genre in props.game.genres" :key="genre" class="tile__genre">{{
          genre
        }}</span>
      </div>
      <span v-else class="tile__nogenres">жанры не указаны</span>

      <span class="tile__platforms">{{ platformsText }}</span>

      <div class="tile__scores">
        <ScoreBadge kind="critic" :value="props.game.bestMetascore" size="md" label />
        <ScoreBadge kind="user" :value="props.game.bestUserscore" size="md" label />
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  overflow: hidden;
  color: inherit;
}

.tile:hover {
  border-color: var(--border-hover);
  color: inherit;
}

.tile__cover {
  position: relative;
  border-bottom: 1px solid var(--border);
}

.tile__failed {
  position: absolute;
  top: 9px;
  left: 9px;
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  padding: 4px 7px;
  border-radius: 5px;
  background: rgba(12, 12, 13, 0.86);
  border: 1px solid oklch(0.62 0.2 25);
  color: oklch(0.78 0.15 25);
}

.tile__body {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 13px 13px 14px;
  flex: 1;
}

.tile__title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  text-wrap: pretty;
}

.tile__meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: #7d7d85;
}

.tile__genres {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.tile__genre {
  font-size: 11px;
  color: var(--text-3);
  background: #1e1e23;
  border-radius: 5px;
  padding: 3px 7px;
}

.tile__nogenres {
  font-family: var(--mono);
  font-size: 10px;
  color: #64646c;
}

.tile__platforms {
  font-size: 11.5px;
  color: var(--muted-2);
  line-height: 1.4;
}

.tile__scores {
  display: flex;
  gap: 12px;
  padding-top: 3px;
  margin-top: auto;
}
</style>
