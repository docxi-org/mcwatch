<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { stampText } from './lib/format.js';
import { crawlerLastRun, useServiceStatus } from './lib/serviceStatus.js';

const route = useRoute();
const { status, load } = useServiceStatus();

onMounted(() => {
  void load();
});

const onMonitoring = computed(() => route.name === 'monitoring');
const crawlStamp = computed(() =>
  status.value === null ? null : stampText(crawlerLastRun(status.value)),
);
</script>

<template>
  <div class="shell">
    <header class="head">
      <div class="head__left">
        <RouterLink class="head__logo" :to="{ name: 'list' }"
          >mcwatch<span class="head__dot">.</span></RouterLink
        >
        <span class="head__tag">{{
          onMonitoring ? 'мониторинг сервиса' : 'каталог новых релизов с Metacritic'
        }}</span>
      </div>
      <!--
        Из каталога на служебный экран ссылки нет: аудитории разные
        (`ui/Спека.dc.html`). Обратная ссылка нужна — на мониторинг приходят
        по прямому адресу.
      -->
      <RouterLink v-if="onMonitoring" class="head__back mono" :to="{ name: 'list' }"
        >→ каталог</RouterLink
      >
      <span v-else-if="crawlStamp" class="head__stamp mono">обход: {{ crawlStamp }}</span>
    </header>

    <RouterView />
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 26px 0 22px;
  border-bottom: 1px solid #1e1e22;
}

.head__left {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.head__logo {
  font-size: 25px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: #f4f5f7;
}

.head__logo:hover {
  color: #fff;
}

.head__dot {
  color: var(--accent);
}

.head__tag {
  font-size: 13px;
  color: #85858d;
}

.head__stamp {
  font-size: 11px;
  color: var(--muted-2);
}

.head__back {
  font-size: 11px;
}
</style>
