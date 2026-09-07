<script setup lang="ts">
import { computed } from 'vue';
import type { LetsplayDto } from '../api/types.js';
import { durationText, viewsText } from '../lib/format.js';

/**
 * Заключение по летсплею — дополнительная часть 1 ТЗ. В брифе дизайнера этого
 * блока нет: он писался до того, как летсплеи появились, поэтому вёрстка
 * собрана в том же языке, что и остальные блоки карточки.
 *
 * Пересказ делает нейросеть по расшифровке речи автора ролика, и об этом
 * сказано прямо: это не редакционный текст.
 */
const props = defineProps<{ letsplay: LetsplayDto | null }>();

const VIBE: Record<string, { label: string; tone: string }> = {
  positive: { label: 'автору понравилось', tone: 'good' },
  mixed: { label: 'впечатление смешанное', tone: 'mixed' },
  negative: { label: 'автору не понравилось', tone: 'bad' },
};

const vibe = computed(() => (props.letsplay?.vibe ? VIBE[props.letsplay.vibe] : null));

/** Почему заключения нет. Молчаливой пустоты тут быть не должно. */
const absence = computed<string | null>(() => {
  const status = props.letsplay?.status ?? 'pending';
  if (props.letsplay && status === 'done' && props.letsplay.conclusion) return null;
  switch (status) {
    case 'no_video':
      return 'Подходящего летсплея не нашлось: либо роликов по игре нет, либо все найденные оказались про другую игру — это проверяет нейросеть по расшифровке речи.';
    case 'no_transcript':
      return 'Ролики есть, но во всех молчат: без речи пересказывать нечего. Такие прохождения выходят с пометкой «No Commentary».';
    case 'failed':
      return 'Последняя попытка сорвалась. Сервис вернётся к этой игре в следующем цикле.';
    default:
      return 'Летсплей для этой игры ещё не искали. Поиск идёт в том же часовом цикле, что и обход Metacritic.';
  }
});
</script>

<template>
  <section class="section">
    <div class="section__head">
      <h2 class="section__title">Что говорят в летсплее</h2>
      <span class="section__note">пересказ речи автора ролика</span>
    </div>

    <div v-if="props.letsplay && absence === null" class="lp">
      <div class="lp__head">
        <span v-if="vibe" class="lp__vibe" :class="`lp__vibe--${vibe.tone}`">{{ vibe.label }}</span>
        <span class="lp__meta mono">
          {{ props.letsplay.channel ?? 'канал неизвестен' }} ·
          {{ viewsText(props.letsplay.views) }} · {{ durationText(props.letsplay.durationS) }}
        </span>
      </div>

      <p class="lp__text">{{ props.letsplay.conclusion }}</p>

      <div v-if="props.letsplay.highlights.length > 0" class="lp__tags">
        <span v-for="item in props.letsplay.highlights" :key="item" class="lp__tag">{{
          item
        }}</span>
      </div>

      <a
        v-if="props.letsplay.url"
        class="lp__link"
        :href="props.letsplay.url"
        target="_blank"
        rel="noopener noreferrer"
        >{{ props.letsplay.title ?? 'смотреть ролик' }} ↗</a
      >
    </div>

    <div v-else class="empty">
      <span class="empty__title">Заключения пока нет</span>
      <span class="empty__note">{{ absence }}</span>
    </div>
  </section>
</template>

<style scoped>
.lp {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 17px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}

.lp__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.lp__vibe {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 4px 8px;
  border-radius: 5px;
  border: 1px solid currentcolor;
}

.lp__vibe--good {
  color: var(--good);
}

.lp__vibe--mixed {
  color: var(--mixed);
}

.lp__vibe--bad {
  color: var(--bad-hi);
}

.lp__meta {
  font-size: 10px;
  color: var(--muted-2);
}

.lp__text {
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--text-2);
  max-width: 62ch;
  text-wrap: pretty;
}

.lp__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.lp__tag {
  font-size: 12px;
  color: var(--text-3);
  background: #1e1e23;
  border-radius: var(--r-sm);
  padding: 5px 9px;
}

.lp__link {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}
</style>
