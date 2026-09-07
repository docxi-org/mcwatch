<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, fetchPipeline } from '../api/client.js';
import type { PipelineDto } from '../api/types.js';
import { countText, durationText } from '../lib/format.js';
import { costText, durationMsText, numberText } from '../lib/pipeline.js';
import PipelineStage from './PipelineStage.vue';

/**
 * Окно конвейера — `docs/UI-BRIEF-PIPELINE.md`. Показывает, как получилась
 * карточка: что уходило в модель, что она вернула и что с ответом сделал код.
 *
 * Управления конвейером здесь нет и не будет: перезапуска шага, правки
 * запроса и повторного вызова в API не существует. Это окно, а не пульт.
 */
const props = defineProps<{ slug: string; title: string; stage: string | null }>();
const emit = defineEmits<{ close: []; stage: [key: string | null] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const data = ref<PipelineDto | null>(null);
const loading = ref(true);
const failure = ref<ApiError | null>(null);
/** Раскрытый этап отражается в адресе: ссылкой можно поделиться. */
const openKey = ref<string | null>(props.stage);

function onClickBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) emit('close');
}

function toggle(key: string): void {
  openKey.value = openKey.value === key ? null : key;
  emit('stage', openKey.value);
}

onMounted(async () => {
  dialog.value?.showModal();
  try {
    data.value = await fetchPipeline(props.slug);
  } catch (err) {
    failure.value = err instanceof ApiError ? err : new ApiError(0, 'неизвестный сбой');
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  dialog.value?.close();
});

/** Ничего не записано — не ошибка: игру собрали до появления записи. */
const nothingRecorded = computed(
  () => data.value !== null && data.value.totals.calls === 0,
);

const totals = computed(() => {
  const t = data.value?.totals;
  if (!t) return [];
  return [
    { key: 'ВЫЗОВОВ К МОДЕЛИ', value: String(t.calls), note: countText(t.failed, 'сорвался', 'сорвались', 'сорвались') },
    { key: 'ТОКЕНОВ НА ВХОДЕ', value: numberText(t.promptTokens), note: 'сырьё всех вызовов' },
    { key: 'ТОКЕНОВ НА ВЫХОДЕ', value: numberText(t.completionTokens), note: 'ответы модели' },
    { key: 'ВРЕМЯ МОДЕЛИ', value: durationMsText(t.durationMs), note: 'сумма по вызовам' },
    { key: 'СТОИМОСТЬ, ОЦЕНКА', value: costText(t.costUsd), note: 'по прайсу из конфига' },
  ];
});

const candidatesNote = computed(() => {
  const n = data.value?.candidates.length ?? 0;
  return `${countText(n, 'ролик', 'ролика', 'роликов')} по убыванию просмотров`;
});
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    aria-label="Конвейер сборки игры"
    @click="onClickBackdrop"
    @cancel.prevent="emit('close')"
  >
    <div class="modal__box">
      <header class="modal__head">
        <span class="modal__title-box">
          <span class="modal__kicker mono">КОНВЕЙЕР СБОРКИ</span>
          <span class="modal__title">{{ props.title }}</span>
        </span>
        <button type="button" class="modal__close mono" @click="emit('close')">
          закрыть · Esc
        </button>
      </header>

      <div class="modal__body noscroll">
        <span v-if="loading" class="note mono">запрашиваем оглавление конвейера…</span>

        <div v-else-if="failure" class="fail">
          <span class="fail__code mono">{{ failure.status === 0 ? 'нет связи' : failure.status }}</span>
          <span class="fail__title">Записей по этому адресу нет</span>
          <span class="fail__note"
            >Игра могла быть удалена из каталога, или адрес устарел. Список игр обновляется раз в
            час.</span
          >
          <span class="fail__tech mono">GET /api/games/{{ props.slug }}/pipeline → {{ failure.message }}</span>
        </div>

        <template v-else-if="data">
          <div v-if="nothingRecorded" class="empty">
            <span class="empty__title">По этой игре записей нет</span>
            <span class="empty__note"
              >Игра собрана до того, как сервис начал записывать вызовы модели. Резюме и заключения
              на карточке настоящие, но восстановить, что именно уходило в модель, уже нельзя —
              выдумывать это мы не станем.</span
            >
          </div>

          <template v-else>
            <div class="totals-box">
              <div class="totals">
                <div v-for="t in totals" :key="t.key" class="total">
                  <span class="total__key mono">{{ t.key }}</span>
                  <span class="total__value mono">{{ t.value }}</span>
                  <span class="total__note mono">{{ t.note }}</span>
                </div>
              </div>
              <span class="totals__note"
                >Стоимость — оценка по прайсу из конфига: провайдер её не присылает.</span
              >
            </div>

            <div class="stages">
              <span class="stages__label mono">ЭТАПЫ В ПОРЯДКЕ ВЫПОЛНЕНИЯ</span>
              <PipelineStage
                v-for="(stage, i) in data.stages"
                :key="stage.key"
                :slug="props.slug"
                :stage="stage"
                :index="i"
                :open="openKey === stage.key"
                @toggle="toggle(stage.key)"
              />
            </div>

            <div v-if="data.candidates.length > 0" class="cands">
              <div class="cands__head">
                <span class="cands__title">Кандидаты в летсплеи</span>
                <span class="cands__note mono">{{ candidatesNote }}</span>
              </div>
              <div class="cands__grid">
                <div
                  v-for="c in data.candidates"
                  :key="c.videoId"
                  class="cand"
                  :class="{
                    'cand--taken': c.outcome === 'взят',
                    'cand--rejected': c.matches === false,
                  }"
                >
                  <span class="cand__ids mono">
                    <span class="cand__pos">{{ c.position }}</span>
                    <span class="cand__id">{{ c.videoId }}</span>
                  </span>
                  <span class="cand__title">{{ c.title }}</span>
                  <span class="cand__meta mono">
                    {{ c.channel ?? 'канал неизвестен' }} ·
                    {{ numberText(c.views) }} просмотров ·
                    {{ durationText(c.durationS) }}
                  </span>
                  <span class="cand__meta mono">{{
                    c.transcriptChars === null
                      ? 'расшифровки нет'
                      : `расшифровка ${numberText(c.transcriptChars)} знаков`
                  }}</span>
                  <span v-if="c.confidence" class="cand__verdict mono"
                    >судья: {{ c.matches ? 'та же игра' : 'другая игра' }} · уверенность
                    {{ c.confidence }}</span
                  >
                  <span v-if="c.reason" class="cand__reason">{{ c.reason }}</span>
                  <span class="cand__outcome">{{ c.outcome }}</span>
                </div>
              </div>
            </div>
          </template>
        </template>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.modal {
  border: none;
  background: transparent;
  padding: 20px;
  width: 100%;
  max-width: 100vw;
  max-height: 100dvh;
  color: var(--text);
}

.modal::backdrop {
  background: rgba(8, 8, 9, 0.88);
}

.modal__box {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1020px;
  height: 88dvh;
  margin: 0 auto;
  background: #101013;
  border: 1px solid #2a2a30;
  border-radius: 14px;
  overflow: hidden;
}

@media (max-width: 640px) {
  .modal {
    padding: 0;
  }

  .modal__box {
    height: 100dvh;
    border-radius: 0;
    border: none;
  }
}

.modal__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.modal__title-box {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.modal__kicker {
  font-size: 9.5px;
  letter-spacing: 0.07em;
  color: var(--muted-2);
}

.modal__title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.25;
  text-wrap: pretty;
}

.modal__close {
  flex: none;
  min-height: 34px;
  border: 1px solid #35353d;
  background: #1c1c21;
  color: #c6c7cd;
  border-radius: 7px;
  padding: 0 11px;
  font-size: 11px;
}

.modal__close:hover {
  border-color: var(--accent);
}

/* Прокрутка живёт здесь: страница под окном ездить не должна. */
.modal__body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 26px;
}

.note {
  font-size: 11px;
  color: var(--muted-2);
}

.totals-box {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.totals {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

@media (min-width: 760px) {
  .totals {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

.total {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 13px 14px;
  background: var(--surface);
}

.total__key {
  font-size: 9px;
  letter-spacing: 0.05em;
  color: var(--muted-2);
}

.total__value {
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.total__note {
  font-size: 9.5px;
  color: var(--muted-2);
}

.totals__note {
  font-size: 12px;
  color: var(--muted-2);
  line-height: 1.5;
}

.stages {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.stages__label {
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--muted-2);
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 34px 22px;
  border: 1px dashed var(--border-strong);
  border-radius: 11px;
}

.empty__title {
  font-size: 16px;
  font-weight: 600;
}

.empty__note {
  font-size: 13.5px;
  color: var(--muted);
  line-height: 1.6;
  max-width: 60ch;
  text-wrap: pretty;
}

.fail {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 13px;
  padding: 40px 8px;
}

.fail__code {
  font-size: 44px;
  font-weight: 700;
  line-height: 1;
  color: #2f2f36;
}

.fail__title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.fail__note {
  font-size: 14px;
  color: var(--muted);
  line-height: 1.6;
  max-width: 56ch;
  text-wrap: pretty;
}

.fail__tech {
  font-size: 10.5px;
  color: var(--muted-3);
  margin-top: 6px;
  padding: 8px 11px;
  background: #131316;
  border: 1px solid var(--border);
  border-radius: 7px;
  word-break: break-all;
}

.cands {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cands__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.cands__title {
  font-size: 15px;
  font-weight: 600;
}

.cands__note {
  font-size: 9.5px;
  color: var(--muted-2);
}

.cands__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}

@media (min-width: 760px) {
  .cands__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.cand {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 13px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  border-left: 2px solid var(--border-strong);
}

.cand--taken {
  border-left-color: var(--good);
}

.cand--rejected {
  border-left-color: var(--bad);
}

.cand__ids {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 10px;
}

.cand__pos {
  color: var(--muted-3);
}

.cand__id {
  color: #79a9b8;
}

.cand__title {
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.35;
  text-wrap: pretty;
}

.cand__meta {
  font-size: 10px;
  color: var(--muted-2);
  line-height: 1.5;
}

.cand__verdict {
  font-size: 10px;
  color: var(--text-3);
}

.cand__reason {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.55;
  text-wrap: pretty;
}

.cand__outcome {
  font-size: 12px;
  color: var(--muted);
  padding-top: 2px;
  border-top: 1px solid var(--border);
}
</style>
