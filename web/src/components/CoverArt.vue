<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * Обложка. Аспект 3:4 задан до загрузки, поэтому сетка не дёргается ни при
 * медленной картинке, ни при её отсутствии. Обложки приходят оригиналом с
 * чужого домена по 300–500 КБ — уменьшить их негде, зато вне экрана они не
 * грузятся (`ui/Спека.dc.html`, раздел «Обложки»).
 */
const props = withDefaults(
  defineProps<{
    src: string | null;
    title: string;
    size?: 'mini' | 'tile' | 'card';
  }>(),
  { size: 'tile' },
);

const broken = ref(false);

// Смена игры при том же узле (переход к похожей) обязана сбросить отметку,
// иначе новая обложка навсегда осталась бы «битой».
watch(
  () => props.src,
  () => {
    broken.value = false;
  },
);
</script>

<template>
  <div class="cover hatch" :class="`cover--${props.size}`">
    <img
      v-if="props.src && !broken"
      class="cover__img"
      :src="props.src"
      :alt="`Обложка игры ${props.title}`"
      loading="lazy"
      decoding="async"
      @error="broken = true"
    />
    <div v-else class="cover__stub">
      <span class="cover__title">{{ props.title }}</span>
      <span class="cover__note">{{
        broken ? 'ССЫЛКА НА ОБЛОЖКУ НЕ ОТКРЫЛАСЬ' : 'ОБЛОЖКИ НЕТ'
      }}</span>
    </div>
  </div>
</template>

<style scoped>
.cover {
  position: relative;
  aspect-ratio: 3 / 4;
  background-color: #1b1b20;
  display: grid;
  place-items: center;
  padding: 12px;
  text-align: center;
  overflow: hidden;
}

.cover__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover__stub {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.cover__title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.25;
  color: #b9bac0;
  text-wrap: pretty;
}

.cover__note {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--muted-2);
  letter-spacing: 0.06em;
  line-height: 1.5;
}

.cover--mini {
  padding: 10px;
}

.cover--mini .cover__title {
  font-size: 12px;
  font-weight: 600;
}

.cover--mini .cover__note {
  display: none;
}

.cover--card {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.cover--card .cover__title {
  font-size: 22px;
}

.cover--card .cover__note {
  font-size: 10px;
}
</style>
