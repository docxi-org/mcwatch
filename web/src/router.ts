import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import GameView from './views/GameView.vue';
import ListView from './views/ListView.vue';
import MonitoringView from './views/MonitoringView.vue';
import NotFoundView from './views/NotFoundView.vue';

/**
 * Три маршрута. Отбор списка живёт в query, карточка открывается ссылкой
 * `/game/:slug` и работает без списка (`docs/UI-BRIEF.md` §3).
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'list', component: ListView },
  { path: '/game/:slug', name: 'game', component: GameView, props: true },
  { path: '/monitoring', name: 'monitoring', component: MonitoringView },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  /**
   * Прокрутку списка восстанавливает сам список: он хранит и загруженные
   * страницы тоже, а браузерная позиция без них бессмысленна.
   */
  scrollBehavior(to, _from, saved) {
    if (to.name === 'list' && saved) return false;
    return saved ?? { top: 0 };
  },
});
