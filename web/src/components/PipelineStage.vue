<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ApiError, fetchRunPayload, type RunPayloadDto } from '../api/client.js';
import type { PipelineRunDto, PipelineStageDto } from '../api/types.js';
import { collapse, costText, durationMsText, numberText, searchHits } from '../lib/pipeline.js';
import JsonView from './JsonView.vue';

/**
 * Один этап конвейера. Сырьё тянется отдельным запросом и только при
 * раскрытии: у судьи это до 56 000 знаков, и грузить их вместе с оглавлением
 * бриф запрещает прямо.
 */
const props = defineProps<{
  slug: string;
  stage: PipelineStageDto;
  index: number;
  open: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

const runIndex = ref(0);
const payload = ref<RunPayloadDto | null>(null);
const loading = ref(false);
const failure = ref<string | null>(null);
const expanded = ref(false);
const query = ref('');

const run = computed<PipelineRunDto | null>(() => props.stage.runs[runIndex.value] ?? null);

const KIND_TEXT = { llm: 'МОДЕЛЬ', code: 'БЕЗ МОДЕЛИ' } as const;
const STATUS_TEXT = { done: 'СДЕЛАНО', skipped: 'ПРОПУЩЕНО', failed: 'СОРВАЛОСЬ' } as const;

async function loadPayload(): Promise<void> {
  const current = run.value;
  if (!current) return;

  loading.value = true;
  failure.value = null;
  payload.value = null;
  try {
    payload.value = await fetchRunPayload(props.slug, current.id);
  } catch (err) {
    failure.value = err instanceof ApiError ? err.message : 'сырьё не пришло';
  } finally {
    loading.value = false;
  }
}

// Запрос уходит на раскрытии шага и на смене вызова, а не заранее.
watch(
  () => [props.open, runIndex.value] as const,
  ([isOpen]) => {
    if (isOpen && props.stage.kind === 'llm' && run.value) void loadPayload();
  },
  { immediate: true },
);

const system = computed(() => payload.value?.system ?? '');
const prompt = computed(() => payload.value?.prompt ?? '');
const shownPrompt = computed(() => collapse(prompt.value, expanded.value));
const hits = computed(() => searchHits(prompt.value, query.value));
const searching = computed(() => query.value.trim().length > 0);

const outputText = computed(() =>
  payload.value?.output === null || payload.value?.output === undefined
    ? ''
    : JSON.stringify(payload.value.output, null, 2),
);

function runLabel(r: PipelineRunDto, i: number): string {
  const mark = r.status === 'failed' ? '× ' : '';
  return `${mark}${r.subject ?? `вызов ${i + 1}`}`;
}
</script>

<template>
  <div class="stage" :class="{ 'stage--open': props.open }">
    <button
      type="button"
      class="stage__head"
      :aria-expanded="props.open"
      :aria-label="`${props.open ? 'Свернуть' : 'Раскрыть'} этап «${props.stage.title}»`"
      @click="emit('toggle')"
    >
      <span class="stage__num mono">{{ String(props.index + 1).padStart(2, '0') }}</span>
      <span class="stage__body">
        <span class="stage__line">
          <span class="stage__title">{{ props.stage.title }}</span>
          <span class="stage__badge mono" :class="`stage__badge--${props.stage.kind}`">{{
            KIND_TEXT[props.stage.kind]
          }}</span>
          <span class="stage__badge mono" :class="`stage__badge--${props.stage.status}`">{{
            STATUS_TEXT[props.stage.status]
          }}</span>
        </span>
        <span class="stage__summary">{{ props.stage.summary }}</span>
      </span>
      <span class="stage__chevron mono" aria-hidden="true">{{ props.open ? '−' : '+' }}</span>
    </button>

    <div v-if="props.open" class="stage__detail">
      <!-- Пропуск — не ошибка, и он объясняет себя словами. -->
      <div v-if="props.stage.status === 'skipped'" class="stage__skip">
        Вызова не было: {{ props.stage.summary }}. Пропуск — не ошибка, дальше конвейер пошёл как
        обычно.
      </div>

      <template v-else-if="props.stage.kind === 'code'">
        <span class="stage__label mono">ЧТО ПРОИЗОШЛО · БЕЗ МОДЕЛИ</span>
        <div class="facts">
          <div v-for="f in props.stage.facts" :key="f.key" class="facts__row">
            <span class="facts__key mono">{{ f.key }}</span>
            <span class="facts__value">{{ f.value }}</span>
          </div>
        </div>
      </template>

      <template v-else>
        <!-- Несколько вызовов на этапе — у судьи столько, сколько роликов. -->
        <div v-if="props.stage.runs.length > 1" class="runs">
          <span class="stage__label mono"
            >{{ props.stage.runs.length }} вызова на этапе · выберите</span
          >
          <div class="runs__tabs noscroll" role="group" aria-label="Вызовы этапа">
            <button
              v-for="(r, i) in props.stage.runs"
              :key="r.id"
              type="button"
              class="runs__tab mono"
              :class="{ 'runs__tab--on': i === runIndex, 'runs__tab--failed': r.status === 'failed' }"
              @click="runIndex = i"
            >
              {{ runLabel(r, i) }}
            </button>
          </div>
        </div>

        <div v-if="loading" class="skel">
          <span class="skel__note mono">GET /pipeline/runs/… — запрашиваем сырьё этого вызова</span>
          <span class="skel__line skel__line--a"></span>
          <span class="skel__line skel__line--b"></span>
          <span class="skel__line skel__line--c"></span>
        </div>

        <div v-else-if="failure" class="stage__skip">Сырьё не пришло: {{ failure }}</div>

        <template v-else-if="run && payload">
          <!-- ── Сырьё ─────────────────────────────────────────────────── -->
          <div class="block">
            <span class="stage__label mono">СЫРЬЁ · ЧТО УШЛО В МОДЕЛЬ</span>

            <div v-if="system" class="raw">
              <span class="raw__head mono">
                <span>ПОСТОЯННАЯ ЧАСТЬ · ОДИНАКОВА ДЛЯ ВСЕХ ИГР</span>
                <span>{{ numberText(system.length) }} знаков</span>
              </span>
              <pre class="raw__text raw__text--system noscroll">{{ system }}</pre>
            </div>
            <span v-else class="raw__none"
              >Постоянной части нет: у эмбеддингов инструкции не бывает.</span
            >

            <div class="raw">
              <span class="raw__head mono">
                <span>ПЕРЕМЕННАЯ ЧАСТЬ · ДАННЫЕ ЭТОЙ ИГРЫ</span>
                <span>{{ numberText(prompt.length) }} знаков</span>
              </span>

              <div v-if="shownPrompt.collapsible || prompt.length > 400" class="raw__tools">
                <input
                  v-model="query"
                  type="search"
                  class="raw__search mono"
                  aria-label="Поиск по сырью вызова"
                  placeholder="поиск по сырью"
                />
                <button
                  v-if="shownPrompt.collapsible"
                  type="button"
                  class="raw__more mono"
                  @click="expanded = !expanded"
                >
                  {{ expanded ? 'свернуть' : `показать целиком · +${numberText(shownPrompt.hiddenChars)}` }}
                </button>
              </div>

              <template v-if="searching">
                <span v-if="hits.length > 0" class="raw__hits mono"
                  >совпало строк: {{ hits.length }}</span
                >
                <div v-if="hits.length > 0" class="hits noscroll">
                  <span v-for="h in hits" :key="h.num" class="hits__row mono">
                    <span class="hits__num">{{ h.num }}</span>
                    <span class="hits__text">{{ h.text }}</span>
                  </span>
                </div>
                <span v-else class="raw__none raw__none--boxed"
                  >В сырье этого вызова совпадений нет.</span
                >
              </template>

              <template v-else>
                <pre class="raw__text noscroll">{{ shownPrompt.text }}</pre>
                <span v-if="shownPrompt.hiddenChars > 0" class="raw__cut mono"
                  >…и ещё {{ numberText(shownPrompt.hiddenChars) }} знаков</span
                >
              </template>
            </div>
          </div>

          <!-- ── Работа модели ─────────────────────────────────────────── -->
          <div class="block">
            <span class="stage__label mono"
              >РАБОТА МОДЕЛИ · {{ run.status === 'failed' ? 'ВЫЗОВ СОРВАЛСЯ' : 'ВЫЗОВ УДАЛСЯ' }}</span
            >
            <div class="metrics">
              <div class="metric">
                <span class="metric__key mono">МОДЕЛЬ</span>
                <span class="metric__value metric__value--text mono">{{ run.model }}</span>
              </div>
              <div class="metric">
                <span class="metric__key mono">ПОПЫТОК</span>
                <span class="metric__value mono">{{ run.attempts }}</span>
                <span v-if="run.attempts > 1" class="metric__note mono">были повторы</span>
              </div>
              <div class="metric">
                <span class="metric__key mono">ДЛИТЕЛЬНОСТЬ</span>
                <span class="metric__value mono">{{ durationMsText(run.durationMs) }}</span>
              </div>
              <div class="metric">
                <span class="metric__key mono">ТОКЕНОВ НА ВХОДЕ</span>
                <span class="metric__value mono">{{ numberText(run.promptTokens) }}</span>
              </div>
              <div class="metric">
                <span class="metric__key mono">ТОКЕНОВ НА ВЫХОДЕ</span>
                <span class="metric__value mono">{{ numberText(run.completionTokens) }}</span>
              </div>
              <div class="metric">
                <span class="metric__key mono">СТОИМОСТЬ, ОЦЕНКА</span>
                <span class="metric__value mono">{{ costText(run.costUsd) }}</span>
              </div>
            </div>
            <span v-if="run.batchSize > 1" class="batch">
              Вызов обслужил пачку из {{ run.batchSize }} игр: текст выше — этой игры, а токены и
              время посчитаны на всю пачку.
            </span>
          </div>

          <!-- ── Решение ───────────────────────────────────────────────── -->
          <div class="block">
            <span class="stage__label mono">РЕШЕНИЕ</span>

            <div v-if="outputText" class="raw">
              <span class="raw__head mono"><span>ЧТО ВЕРНУЛА МОДЕЛЬ</span></span>
              <JsonView class="raw__json" :text="outputText" />
            </div>
            <span v-else class="raw__none raw__none--boxed"
              >Модель не вернула ответа — вызов сорвался, разбирать нечего.</span
            >

            <!-- Ответ модели и решение кода — разные строки. -->
            <div class="decision">
              <span class="decision__key mono">ЧТО СДЕЛАЛ КОД</span>
              <span class="decision__value">{{ run.decision }}</span>
            </div>

            <div v-if="run.error" class="failure">
              <span class="failure__key mono">ОШИБКА ВЫЗОВА</span>
              <span class="failure__value">{{ run.error }}</span>
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.stage {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface);
}

.stage--open {
  background: #131316;
}

.stage__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 13px 15px;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
}

.stage__head:hover {
  background: var(--surface-3);
}

.stage__num {
  flex: none;
  width: 34px;
  font-size: 9.5px;
  color: var(--muted-3);
  padding-top: 3px;
}

.stage__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}

.stage__line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.stage__title {
  font-size: 14.5px;
  font-weight: 600;
}

.stage__badge {
  font-size: 8.5px;
  letter-spacing: 0.06em;
  padding: 3px 6px;
  border-radius: 4px;
  background: #22232a;
  color: #9a9ba3;
}

.stage__badge--llm {
  background: rgba(60, 150, 180, 0.14);
  color: var(--accent);
}

.stage__badge--done {
  background: rgba(60, 150, 180, 0.1);
  color: #8fb3bf;
}

.stage__badge--failed {
  background: rgba(180, 60, 40, 0.14);
  color: var(--bad-hi);
}

.stage__summary {
  font-size: 12.5px;
  color: var(--text-3);
  line-height: 1.5;
  text-wrap: pretty;
}

.stage__chevron {
  flex: none;
  font-size: 15px;
  color: var(--muted-2);
  padding-top: 1px;
}

.stage__detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 15px 16px 61px;
}

.stage__label {
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--muted-2);
}

.stage__skip {
  padding: 12px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.55;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.facts {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.facts__row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: space-between;
  padding: 9px 12px;
  background: var(--surface);
}

.facts__key {
  font-size: 10.5px;
  color: #85858d;
}

.facts__value {
  font-size: 12.5px;
  color: var(--text-2);
  text-align: right;
  min-width: 0;
}

.runs {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.runs__tabs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 3px;
}

.runs__tab {
  flex: none;
  min-height: 30px;
  padding: 0 11px;
  border-radius: 7px;
  font-size: 10.5px;
  border: 1px solid #33333a;
  background: #1c1c21;
  color: var(--text-3);
}

.runs__tab--on {
  border-color: var(--accent);
  background: rgba(60, 150, 180, 0.14);
  color: var(--accent);
}

.runs__tab--failed {
  color: var(--bad-hi);
}

.skel {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 16px 0;
}

.skel__note {
  font-size: 10px;
  color: var(--muted-2);
}

.skel__line {
  height: 10px;
  border-radius: 4px;
  background: #1a1a1e;
}

.skel__line--a {
  width: 70%;
  background: #1e1e23;
}

.skel__line--b {
  width: 90%;
}

.skel__line--c {
  width: 55%;
}

.raw {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.raw__head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 9.5px;
  color: #85858d;
}

/* Своя прокрутка у каждого блока: страница целиком ездить не должна. */
.raw__text {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  padding: 11px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.65;
  color: #a9c7d1;
  white-space: pre-wrap;
  word-break: break-word;
}

.raw__text--system {
  max-height: 150px;
  color: #9aa7ab;
}

.raw__json {
  max-height: 220px;
  overflow: auto;
  padding: 11px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.raw__none {
  font-size: 12.5px;
  color: var(--muted-2);
  line-height: 1.5;
}

.raw__none--boxed {
  padding: 11px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  color: var(--muted);
}

.raw__tools {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  align-items: center;
}

.raw__search {
  flex: 1 1 180px;
  min-width: 0;
  background: var(--bg);
  border: 1px solid #2a2a30;
  border-radius: 7px;
  padding: 8px 11px;
  color: var(--text);
  font-size: 11px;
  outline: none;
}

.raw__search:focus {
  border-color: var(--accent);
}

.raw__more {
  flex: none;
  min-height: 32px;
  padding: 0 11px;
  border-radius: 7px;
  border: 1px solid #33333a;
  background: #1c1c21;
  color: var(--text-3);
  font-size: 10.5px;
}

.raw__more:hover {
  border-color: var(--accent);
}

.raw__hits,
.raw__cut {
  font-size: 9.5px;
  color: #79a9b8;
}

.raw__cut {
  color: var(--muted-2);
}

.hits {
  max-height: 240px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.hits__row {
  display: flex;
  gap: 10px;
  padding: 8px 11px;
  background: var(--bg);
  font-size: 11px;
  line-height: 1.6;
  color: #a9c7d1;
}

.hits__num {
  flex: none;
  min-width: 34px;
  text-align: right;
  color: var(--muted-3);
}

.hits__text {
  min-width: 0;
  word-break: break-word;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

@media (min-width: 760px) {
  .metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--surface);
}

.metric__key {
  font-size: 8.5px;
  letter-spacing: 0.05em;
  color: var(--muted-2);
}

.metric__value {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}

.metric__value--text {
  font-size: 12px;
  font-weight: 400;
  word-break: break-all;
}

.metric__note {
  font-size: 9px;
  color: var(--muted-2);
}

.batch {
  font-size: 12.5px;
  color: #ddc9a3;
  line-height: 1.55;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(190, 150, 40, 0.07);
  border: 1px solid oklch(0.45 0.08 92);
}

.decision {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 13px;
  border-radius: 8px;
  background: #17171b;
  border: 1px solid var(--border-strong);
}

.decision__key {
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--muted-2);
}

.decision__value {
  font-size: 13.5px;
  color: var(--text);
  line-height: 1.5;
}

.failure {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 13px;
  border-radius: 8px;
  background: rgba(180, 60, 40, 0.09);
  border: 1px solid oklch(0.42 0.1 25);
}

.failure__key {
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--bad-hi);
}

.failure__value {
  font-size: 12.5px;
  color: #d8b6ae;
  line-height: 1.55;
  word-break: break-word;
}
</style>
