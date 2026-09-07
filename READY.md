# Сделано

Закрытые пункты `TODO.md` и `COMPROMISES.md` с датой и сводкой (RULES п.9).

## 2026-09-07 · G1 · Скелет

`TODO.md` действие 1: «pnpm, TS strict, Hono, Drizzle + миграции, pino,
`pnpm check` зелёный на пустом проекте».

**Сделано.** Каркас на зафиксированном стеке: TypeScript 5.9 strict (+
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`),
ESM/NodeNext, Hono + `@hono/node-server` с `/api/health` и JSON-404, pino
(pretty в dev, JSON в prod), zod-валидация окружения в единственном месте
(`src/config/env.ts`), Drizzle-схема всех 9 таблиц `docs/ARCHITECTURE.md` §3 с
внешними ключами и индексами, сгенерированная миграция `drizzle/0000_*.sql`,
`pnpm db:migrate`. Заведён git-репозиторий, `TASK.md` и `ARCHITECTURE.md`
перенесены в `docs/` (так они уже были записаны в `CLAUDE.md`), созданы
`.gitignore`, `.env.example`, `COMPROMISES.md`, `READY.md`.

**Проверка.** `pnpm check` зелёный: typecheck + eslint (`strictTypeChecked`) +
15 тестов в 2 файлах. Тест миграций поднимает БД во временном каталоге и
сверяет состав таблиц, первичные ключи каждой, работу `UNIQUE(game_slug, kind,
external_id)` и включённые внешние ключи, а также идемпотентность повторного
прогона. Тест HTTP бьёт по `app.request()` без открытия порта. Сверх заявленного
прогнаны `pnpm build` и запуск собранного `dist/server/index.js` с реальным
HTTP-запросом.

**Остаток.** `pnpm crawl --once` из «Команд» `CLAUDE.md` ещё не существует —
он относится к действию 4 (воркер `crawler`). Скрипты `dev`/`build` пока не
собирают фронт: Vue появится на G3.

**Знание, добытое по пути** (перенесено в `docs/ARCHITECTURE.md` §8): у
`better-sqlite3@13.0.3` не опубликованы prebuild-бинарники, версия пиньится на
12.2.0; `typescript-eslint` 8.x не работает с TypeScript 7.
