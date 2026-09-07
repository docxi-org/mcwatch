<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Трейлер в модальном окне. Взят родной `<dialog>`: он сам держит фокус
 * внутри, закрывается по Esc и возвращает фокус на кнопку, с которой открыли.
 * Своя ловушка фокуса тут была бы худшей копией браузерной.
 *
 * Проигрыватель грузится только при открытии — трейлер есть у 11% игр, и
 * тянуть чужой iframe на каждой карточке незачем.
 */
const props = defineProps<{ title: string; url: string }>();
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);

function onClickBackdrop(event: MouseEvent): void {
  // Клик приходит на сам `<dialog>` только если попал в подложку.
  if (event.target === dialog.value) emit('close');
}

onMounted(() => {
  dialog.value?.showModal();
});

onBeforeUnmount(() => {
  dialog.value?.close();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    aria-label="Трейлер игры"
    @click="onClickBackdrop"
    @cancel.prevent="emit('close')"
  >
    <div class="modal__box">
      <div class="modal__head">
        <span class="modal__title">{{ props.title }} — трейлер</span>
        <button type="button" class="modal__close mono" @click="emit('close')">
          закрыть · Esc
        </button>
      </div>
      <div class="modal__frame">
        <iframe
          class="modal__iframe"
          :src="props.url"
          :title="`Трейлер игры ${props.title}`"
          allow="autoplay; fullscreen; encrypted-media"
          allowfullscreen
          loading="lazy"
        ></iframe>
      </div>
      <span class="modal__note mono">проигрыватель чужой — открывается с сайта Metacritic</span>
    </div>
  </dialog>
</template>

<style scoped>
.modal {
  border: none;
  background: transparent;
  padding: 24px;
  max-width: 100vw;
  max-height: 100dvh;
  width: 100%;
  color: var(--text);
}

.modal::backdrop {
  background: rgba(8, 8, 9, 0.86);
}

.modal__box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
}

.modal__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.modal__title {
  font-size: 15px;
  font-weight: 600;
}

.modal__close {
  border: 1px solid #35353d;
  background: #1c1c21;
  color: #c6c7cd;
  border-radius: 7px;
  padding: 8px 11px;
  font-size: 11px;
}

.modal__close:hover {
  border-color: var(--accent);
}

.modal__frame {
  aspect-ratio: 16 / 9;
  background: #16161a;
  border: 1px solid #2a2a30;
  border-radius: 12px;
  overflow: hidden;
}

.modal__iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.modal__note {
  font-size: 10px;
  color: var(--muted-3);
}
</style>
