<script setup lang="ts">
import { computed } from 'vue';
import { jsonTokens } from '../lib/jsonTokens.js';

/**
 * Подсвеченный JSON. Переносится по словам, а не уезжает за край: у события
 * мониторинга и у ответа модели строки бывают длинные, и горизонтальная
 * прокрутка внутри окна читается хуже переноса.
 */
const props = defineProps<{ text: string }>();

const tokens = computed(() => jsonTokens(props.text));
</script>

<template>
  <div class="json noscroll"><span
    v-for="(t, i) in tokens"
    :key="i"
    :class="`json--${t.kind}`"
  >{{ t.text }}</span></div>
</template>

<style scoped>
.json {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: #c8c9cf;
}

.json--key {
  color: #79a9b8;
}

.json--string {
  color: oklch(0.78 0.15 145);
}

.json--number {
  color: oklch(0.84 0.15 92);
}

.json--literal {
  color: oklch(0.76 0.14 300);
}

.json--punct {
  color: var(--muted-3);
}
</style>
