<script setup lang="ts">
import { computed } from 'vue';
import type { SummaryDto } from '../api/types.js';
import { countText, stampText } from '../lib/format.js';

/**
 * Резюме отзывов одного вида. Блоки критиков и игроков независимы: бывает
 * только одно из двух, и пустая колонка объясняет почему, а не исчезает
 * (`docs/UI-BRIEF.md` §5).
 */
const props = defineProps<{
  kind: 'critic' | 'user';
  summary: SummaryDto | null;
  /** Сколько отзывов сохранено. Резюме может отставать от их числа. */
  reviewCount: number;
}>();

const title = computed(() => (props.kind === 'critic' ? 'Критики' : 'Игроки'));

const countLine = computed(() =>
  props.summary
    ? `по ${countText(props.summary.reviewCount, 'отзыву', 'отзывам', 'отзывам')}`
    : props.reviewCount > 0
      ? `${countText(props.reviewCount, 'отзыв', 'отзыва', 'отзывов')} · резюме ещё нет`
      : 'нет отзывов',
);

const absentText = computed(() =>
  props.kind === 'critic'
    ? 'Рецензий критиков по этой игре ещё нет.'
    : 'Игроки пока не оставили отзывов.',
);
</script>

<template>
  <div class="sum" :class="[`sum--${props.kind}`, { 'sum--empty': !props.summary }]">
    <div class="sum__head">
      <span class="sum__title">{{ title }}</span>
      <span class="sum__count mono">{{ countLine }}</span>
    </div>

    <div v-if="props.summary" class="sum__body">
      <div v-if="props.summary.likes.length > 0" class="sum__group">
        <span class="sum__label sum__label--good mono">НРАВИТСЯ</span>
        <span v-for="item in props.summary.likes" :key="item" class="sum__item">
          <span class="sum__mark sum__mark--good mono">+</span>{{ item }}
        </span>
      </div>

      <div v-if="props.summary.dislikes.length > 0" class="sum__group">
        <span class="sum__label sum__label--bad mono">НЕ НРАВИТСЯ</span>
        <span v-for="item in props.summary.dislikes" :key="item" class="sum__item">
          <span class="sum__mark sum__mark--bad mono">−</span>{{ item }}
        </span>
      </div>

      <p class="sum__text">{{ props.summary.summary }}</p>

      <span class="sum__model mono"
        >резюме составлено нейросетью · {{ props.summary.model }} ·
        {{ stampText(props.summary.createdAt) }}</span
      >
    </div>

    <div v-else class="sum__absent">
      <span class="sum__absent-title">{{ absentText }}</span>
      <span class="sum__absent-note mono">резюме появится, когда наберутся отзывы</span>
    </div>
  </div>
</template>

<style scoped>
.sum {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 17px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  border-top: 2px solid var(--accent);
  min-width: 0;
}

.sum--user {
  border-top-color: var(--good);
}

.sum--empty {
  border-top-color: var(--border-strong);
}

.sum__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.sum__title {
  font-size: 14.5px;
  font-weight: 600;
}

.sum__count {
  font-size: 10px;
  color: var(--muted-2);
}

.sum__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sum__group {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.sum__label {
  font-size: 9.5px;
  letter-spacing: 0.06em;
}

.sum__label--good {
  color: var(--good);
}

.sum__label--bad {
  color: oklch(0.68 0.18 25);
}

.sum__item {
  display: flex;
  gap: 9px;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--text-2);
  text-wrap: pretty;
}

.sum__mark {
  flex: none;
}

.sum__mark--good {
  color: var(--good);
}

.sum__mark--bad {
  color: oklch(0.68 0.18 25);
}

.sum__text {
  padding-top: 13px;
  border-top: 1px solid var(--border);
  font-size: 13.5px;
  line-height: 1.6;
  color: #b6b7bd;
  text-wrap: pretty;
}

.sum__model {
  font-size: 9.5px;
  color: var(--muted-3);
  line-height: 1.5;
}

.sum__absent {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 18px 0 8px;
}

.sum__absent-title {
  font-size: 13.5px;
  color: var(--muted);
}

.sum__absent-note {
  font-size: 10px;
  color: var(--muted-3);
}
</style>
