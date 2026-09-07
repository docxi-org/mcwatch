<script setup lang="ts">
/**
 * Неизвестный адрес. Тот же язык, что и у 404 карточки: код, объяснение и
 * выход в каталог — а не пустой экран.
 */
</script>

<template>
  <div class="fail">
    <span class="fail__code mono">404</span>
    <span class="fail__title">Такой страницы нет</span>
    <span class="fail__note"
      >В mcwatch два экрана: список новых релизов и карточка игры. Адрес карточки выглядит как
      <span class="mono">/game/onimusha-way-of-the-sword</span>.</span
    >
    <RouterLink class="btn btn--primary fail__btn" :to="{ name: 'list' }">Ко всем играм</RouterLink>
  </div>
</template>

<style scoped>
.fail {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  max-width: 560px;
  padding: 96px 0 40px;
}

.fail__code {
  font-size: 54px;
  font-weight: 700;
  line-height: 1;
  color: #2f2f36;
  letter-spacing: -0.02em;
}

.fail__title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.fail__note {
  font-size: 14.5px;
  color: var(--muted);
  line-height: 1.6;
  text-wrap: pretty;
}

.fail__btn {
  display: inline-flex;
  align-items: center;
  margin-top: 6px;
}
</style>
