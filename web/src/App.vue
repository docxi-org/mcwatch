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
        Спека Claude Design ссылки из каталога на служебный экран не
        предполагала: аудитории разные. Решение владельца 07.09.2026 —
        поставить её в шапку: без входа мониторинг находится только по
        прямому адресу, а это дополнительная часть ТЗ.
      -->
      <div class="head__right">
        <span v-if="!onMonitoring && crawlStamp" class="head__stamp mono"
          >обход: {{ crawlStamp }}</span
        >
        <RouterLink
          class="head__link mono"
          :to="{ name: onMonitoring ? 'list' : 'monitoring' }"
          >{{ onMonitoring ? '← каталог' : 'мониторинг →' }}</RouterLink
        >
      </div>
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

.head__right {
  display: flex;
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
}

.head__stamp {
  font-size: 11px;
  color: var(--muted-2);
}

/* Служебный вход: заметен тому, кто его ищет, и не спорит с каталогом. */
.head__link {
  font-size: 11px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  color: var(--muted);
}

.head__link:hover {
  color: var(--accent);
}
</style>
