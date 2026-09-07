<script setup lang="ts">
import type { PlatformScoreDto } from '../api/types.js';
import { countText } from '../lib/format.js';
import ScoreBadge from './ScoreBadge.vue';

/**
 * Оценки по платформам. У каждой платформы свой метаскор и своя оценка
 * игроков — это разные числа по разным шкалам, объединять их нельзя
 * (`docs/UI-BRIEF.md` §3.2). Отсутствие оценки — «нет оценки», не ноль.
 */
defineProps<{ rows: PlatformScoreDto[] }>();
</script>

<template>
  <section class="section">
    <div class="section__head">
      <h2 class="section__title">Оценки по платформам</h2>
      <span class="section__note">две шкалы, не сравнимы между собой</span>
    </div>

    <div class="table">
      <div class="table__head mono">
        <span class="table__platform">ПЛАТФОРМА</span>
        <span class="table__critic">КРИТИКИ 0–100</span>
        <span class="table__user">ИГРОКИ 0–10</span>
      </div>

      <div v-for="row in rows" :key="row.platform" class="table__row">
        <span class="table__platform table__name">{{ row.platform }}</span>

        <span class="table__critic table__cell">
          <ScoreBadge
            v-if="row.metascore !== null"
            kind="critic"
            :value="row.metascore"
            size="sm"
          />
          <span v-else class="table__none mono">нет оценки</span>
          <span class="table__count mono">{{
            row.criticCount === null
              ? ''
              : countText(row.criticCount, 'рецензия', 'рецензии', 'рецензий')
          }}</span>
        </span>

        <span class="table__user table__cell">
          <ScoreBadge v-if="row.userscore !== null" kind="user" :value="row.userscore" size="sm" />
          <span v-else class="table__none mono">нет оценки</span>
          <span class="table__count mono">{{
            row.userCount === null ? '' : countText(row.userCount, 'оценка', 'оценки', 'оценок')
          }}</span>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.table {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}

.table__head {
  display: flex;
  gap: 10px;
  padding: 9px 13px;
  background: var(--surface-2);
  font-size: 9.5px;
  letter-spacing: 0.05em;
  color: var(--muted-2);
}

.table__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  background: var(--surface);
}

.table__platform {
  flex: 1 1 auto;
  min-width: 0;
}

.table__name {
  font-size: 13.5px;
  font-weight: 500;
}

.table__critic {
  flex: none;
  width: 92px;
  text-align: center;
}

.table__user {
  flex: none;
  width: 84px;
  text-align: center;
}

.table__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.table__none {
  font-size: 10px;
  color: #64646c;
}

.table__count {
  font-size: 9px;
  color: var(--muted-3);
}
</style>
