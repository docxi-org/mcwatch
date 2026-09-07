# Фронт

Интерфейс на Vue 3 + Vite. Собирается командой `pnpm build:web` в `web/dist`,
откуда его отдаёт тот же процесс, что и API. Запросы идут на относительные
пути `/api/...`; в разработке `vite` проксирует их на бэкенд (`pnpm dev`).

```
src/
  views/       ListView, GameView, MonitoringView, NotFoundView
  components/  ScoreBadge, CoverArt, GameTile, PlatformScores,
               SummaryCard, SimilarGames, LetsplayBlock, TrailerDialog
  lib/         score, listFilters, format, listCache, eventStream, serviceStatus
  api/         client (три маршрута каталога и три мониторинга) и типы
  styles.css   токены палитры, шрифты, базовые состояния
```

Формы ответов не переписываются копией: `src/api/types.ts` реэкспортирует их
из бэкенда типовым импортом. Расхождение форм ломает сборку, а не показ.

Чистая логика (шкалы оценок, отбор в адресе, подписи) вынесена в `lib/` и
проверяется тестами из `test/ui-*.test.ts` наравне с бэкендом.

Замысел и решения — `docs/ARCHITECTURE.md` §9; макет и правила сборки — `ui/`.
Каталога `dist` может не быть: сервер это переживёт и будет отдавать только API.
