<script setup lang="ts">
import { computed } from 'vue';
import { scoreView, type ScoreKind } from '../lib/score.js';

/**
 * Плашка оценки: число, суффикс шкалы внутри плашки и полоса заполнения.
 * Один компонент на все места — иначе две шкалы рано или поздно разъедутся.
 */
const props = withDefaults(
  defineProps<{
    kind: ScoreKind;
    value: number | null;
    size?: 'xs' | 'sm' | 'md' | 'lg';
    bar?: boolean;
    label?: boolean;
  }>(),
  { size: 'md', bar: true, label: false },
);

const view = computed(() => scoreView(props.kind, props.value));
</script>

<template>
  <div class="score" :class="[`score--${props.size}`, `score--${view.tier}`]">
    <div class="score__box">
      <span class="score__value">{{ view.value }}</span>
      <span v-if="view.suffix" class="score__suffix">{{ view.suffix }}</span>
    </div>
    <div v-if="props.bar" class="score__track" aria-hidden="true">
      <div class="score__fill" :style="{ width: `${view.fillPercent}%` }"></div>
    </div>
    <span v-if="props.label" class="score__label">{{ view.shortLabel }}</span>
    <span class="score__sr">{{
      view.present
        ? `${view.scaleLabel}: ${view.value}${view.suffix}`
        : `${view.scaleLabel}: нет оценки`
    }}</span>
  </div>
</template>

<style scoped>
.score {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  /* Цвет градации задаётся тут один раз и разбирается плашкой и полосой. */
  --tone: var(--muted-2);
}

.score--good {
  --tone: var(--good);
}

.score--mixed {
  --tone: var(--mixed);
}

.score--bad {
  --tone: var(--bad);
}

.score__box {
  display: grid;
  grid-auto-flow: column;
  align-items: baseline;
  justify-content: center;
  font-family: var(--mono);
  font-weight: 700;
  line-height: 1;
  /* 7 px — из макета; общий --r-sm (6) плашке чуть тесноват. */
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.045);
  border: 2px solid transparent;
  color: var(--tone);
}

/* Нет оценки — пунктир и прочерк. Никогда не ноль. */
.score--none .score__box {
  background: transparent;
  border-style: dashed;
  border-color: #33333a;
  color: #64646c;
}

.score__suffix {
  font-weight: 500;
  opacity: 0.6;
}

.score__track {
  width: 100%;
  height: 3px;
  border-radius: 2px;
  background: #26262b;
}

.score--none .score__track {
  background: #1e1e23;
}

.score__fill {
  height: 3px;
  border-radius: 2px;
  background: var(--tone);
}

.score--none .score__fill {
  background: transparent;
}

.score__label {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.05em;
  color: var(--muted-2);
  white-space: nowrap;
}

/* Подпись для экранного диктора: цвет и полоса ему ничего не говорят. */
.score__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.score--xs .score__box {
  height: 26px;
  min-width: 26px;
  padding: 0 7px;
  font-size: 12px;
}
.score--xs .score__suffix {
  font-size: 8px;
}

.score--sm .score__box {
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  font-size: 14px;
}
.score--sm .score__suffix {
  font-size: 8.5px;
}

/* В таблице платформ полоса короче плашечной колонки — как в макете. */
.score--sm .score__track {
  width: 62px;
}

.score--md .score__box {
  height: 40px;
  min-width: 40px;
  padding: 0 9px;
  font-size: 17px;
}
.score--md .score__suffix {
  font-size: 9px;
}

.score--lg .score__box {
  height: 52px;
  min-width: 52px;
  padding: 0 11px;
  font-size: 22px;
  border-radius: var(--r-md);
}
.score--lg .score__suffix {
  font-size: 11px;
}
</style>
