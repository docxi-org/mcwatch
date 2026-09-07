# Архитектура mcwatch

Требования — `docs/TASK.md`. Здесь — как они реализуются и что известно об
источниках. Документ обновляется при смене дизайна (RULES п.9).

## 1. Общая схема

```
┌─────────────────────── один Node-процесс ───────────────────────┐
│  Hono HTTP ── /api/*  ── SSE /api/events ── статика (Vue)        │
│  Scheduler (каждый час) ──► jobs (SQLite)                        │
│  Workers: crawler ─► summarizer ─► similarity ─► youtube         │
│  EventBus ─► worker_status / events_log ─► SSE                   │
└──────────────────────────────────────────────────────────────────┘
        │ HTTPS 1 rps          │ OpenRouter            │ YouTube
   metacritic.com        chat + embeddings +      Data API v3,
   backend.metacritic.com   whisper               субтитры, yt-dlp
```

Деплой: Docker Compose на VPS (Нидерланды) — контейнер приложения + Caddy
(HTTPS). SQLite-файл на томе.

## 2. Пайплайн сбора

Ротация по ТЗ:

1. Первый обход дня — 20 игр из блока **New Releases** на `/game/`.
2. Следующие обходы — страницы `/browse/game/all/all/all-time/new/?page=N`,
   по одной странице (24 игры) за обход, N растёт.
3. Смена календарной даты (UTC) → `crawl_state` сбрасывается: снова п.1.

«Сегодня не обрабатывал» — множество `processed_slugs` за текущую дату.
Игра, уже существующая в базе, обновляется (upsert), не пропускается.

Один обход = job `crawl`, внутри последовательно по каждой игре:

```
list → для каждого slug:
  fetch card   → upsert games, game_platforms
  fetch reviews (critic, user) → upsert reviews
  enqueue summarize(slug)      # если есть отзывы и правило обновления сработало
  enqueue embed(slug)          # если description_hash изменился
  enqueue letsplay(slug)       # только при первом появлении игры
```

Каждый шаг по игре обёрнут в try/catch; ошибка помечает элемент и не
прерывает обход. Между запросами к Metacritic — ≥1 с.

Блокировка: новый `crawl` не ставится, пока предыдущий в статусе `running`.
Принудительный запуск (G5) — тот же job через POST `/api/crawl/run`.

## 3. Схема данных (SQLite, Drizzle)

```
games            slug PK, title, cover_url, video_url, developer, publisher,
                 genres JSON, description, release_date, esrb,
                 description_hash, embedding BLOB?, first_seen, last_crawled,
                 status (ok|failed), last_error
game_platforms   game_slug, platform, metascore?, userscore?,
                 critic_count?, user_count?   PK(game_slug, platform)
reviews          id PK, game_slug, kind (critic|user), external_id,
                 score?, score_max (100|10), author, platform?, date?,
                 text, sentiment (positive|mixed|negative)?, url?
                 UNIQUE(game_slug, kind, external_id)
summaries        game_slug, kind, likes JSON, dislikes JSON, summary,
                 model, review_count_at, created_at   PK(game_slug, kind)
letsplays        game_slug PK, video_id?, title?, channel?, views?,
                 duration_s?, transcript_source (captions|whisper)?,
                 conclusion?, status (pending|no_video|no_transcript|done|failed),
                 last_error, updated_at
crawl_state      date PK, phase (landing|browse), next_page, processed_slugs JSON
jobs             id PK, type, payload JSON, status (queued|running|done|failed),
                 attempts, created_at, started_at, finished_at, error
worker_status    worker PK, state (idle|running|error), current_item?,
                 processed_total, failed_total, last_run_at, last_error
events_log       id, ts, worker, level, message, data JSON   (ротация: 5000 строк)
```

Скоры: отсутствие = `NULL`. Metascore 0–100, userscore 0–10 — не смешивать.

## 4. LLM-задачи

Все — через `ai` SDK + `@openrouter/ai-sdk-provider`. Модели в `src/config/models.ts`:
`SUMMARY_MODEL`, `EMBEDDING_MODEL`, `TRANSCRIBE_MODEL`. Дефолты подбираются на
шаге реализации по цене; кандидат на резюме — DeepSeek V4-Flash, thinking выкл.

### 4.1 Резюме отзывов

Вход: до N отзывов одного `kind` (N=40 критики, N=30 пользователи), для
пользователей — сбалансированная выборка по sentiment (не первые N). Длинные
тексты обрезаются до ~600 символов.
Выход (`generateObject`, zod): `{ likes: string[], dislikes: string[], summary: string }`,
на русском независимо от языка отзывов, без выдумывания — только то, что
есть в отзывах.

Правило обновления: пересчитать, если отзывов нет в `summaries` **или**
`review_count_now ≥ review_count_at * 1.2` **или** `+10` **или** прошло 7 дней.
Нет отзывов → резюме нет (null в API, «отзывов пока нет» в UI).

### 4.2 Похожие игры

Score = 0.6·cos(embedding) + 0.3·Jaccard(genres) + 0.1·Jaccard(platforms)
(+0.05 за того же разработчика). Эмбеддинг текста «title · genres · developer ·
description», считается один раз, пересчёт по `description_hash`.
Считается при запросе карточки по всем играм с эмбеддингом (в памяти; при
базе >5k игр — пересмотреть). Топ-5, порог score ≥ 0.45, иначе пустой блок.
Модель эмбеддингов — многоязычная (описания бывают на японском).

### 4.3 Летсплей (G6)

Линейная цепочка, отдельный воркер, своё состояние в `letsplays`:

```
search.list(q="<title> let's play", type=video, order=viewCount, max=10)
→ videos.list(ids): duration ≥ 15 мин, title без trailer/review/teaser
→ выбрать max(viewCount)
→ субтитры (auto/manual, любой язык) → если нет: yt-dlp -x → чанки ≤10 мин
  → OpenRouter /audio/transcriptions
→ первые ~20 мин транскрипта → generateObject {conclusion, vibe}
→ сохранить со ссылкой youtube.com/watch?v=<id>
```

Квота Data API: search = 100 ед. из 10 000/день → ≤100 поисков/день; поиск
только при первом появлении игры, повторный — нет.

## 5. API (черновик)

```
GET  /api/games?platform=&q=&sort=metascore|userscore|date&page=
GET  /api/games/:slug            карточка + platforms + summaries + letsplay + similar
GET  /api/platforms              список для фильтра
GET  /api/status                 worker_status + crawl_state + очередь
GET  /api/events                 SSE: status, log
POST /api/crawl/run              принудительный запуск (409, если идёт)
```

## 6. Знание об источниках

### Metacritic (проверено 07.09.2026)

- Все страницы — SSR (Nuxt), отдаются анонимным GET без Cloudflare-блока.
  Браузер не нужен.
- `/game/` — блок **New Releases** ровно 20 игр, отделён от Upcoming.
- `/browse/game/all/all/all-time/new/` — 24/страница, ~7400 страниц,
  `?page=N`. Поток сырой: мобильный шлак, большинство без скоров. **Описания в
  списке битые** (сдвинуты между соседями) — описание брать только с карточки.
  Порядок при равных датах нестабилен — дедуп по slug.
- Карточка `/game/<slug>/`: title, developer, publisher, genres, description,
  release date, блок All Platforms с Metascore по платформам. Userscore по
  платформе — `?platform=<slug>`. На карточке лишь сэмпл отзывов; полные списки
  `/critic-reviews/?platform=…`, `/user-reviews/?platform=…`.
- **Видео**: если у игры есть трейлер, обложка — `cdn.jwplayer.com/v2/media/<ID>/poster.jpg`;
  `https://cdn.jwplayer.com/v2/media/<ID>` отдаёт JSON плейлиста с mp4.
  Ссылка на видео = этот ID. Иначе обложка — `metacritic.com/a/img/...`, видео нет.
- Критики: издание, дата, платформа, цитата 1–3 предложения, ссылка на
  оригинал, оценка 0–100. Пользователи: ник, полный текст, любой язык,
  оценка 0–10, флаг spoiler. Sentiment (positive/mixed/negative) Metacritic
  отдаёт сам.
- JSON-бэкенд `backend.metacritic.com` (используется фронтом и проектом
  mcp-metacritic, без учётки; `apiKey` зашит в клиентский бандл). Маршруты —
  **сверить в DevTools на шаге разведки**, по памяти:
  `/finder/metacritic/web?…sortBy=-releaseDate&offset&limit`,
  `/composer/metacritic/pages/games/<slug>/web`,
  `/reviews/metacritic/critic/games/<slug>/web`, `…/user/…` (offset/limit).
  Возможно, reviews отдаёт ограниченную выборку — проверить. Первичный путь —
  JSON, HTML — фолбэк и фикстуры.

### YouTube

- Официально: Data API v3 (`search.list` 100 ед., `videos.list` 1 ед., квота
  10 000/день). `captions.download` для чужих видео недоступен.
- Субтитры — неофициальный timedtext через `youtubei.js` / `youtube-transcript`
  / `yt-dlp --write-auto-sub`. С IP датацентров периодически блокируется;
  лечится прокси/куками. Состояние меняется каждые месяцы — проверять
  актуальность `yt-dlp` перед реализацией.
- Whisper через OpenRouter: `POST /api/v1/audio/transcriptions`, base64 или
  multipart ≤25 МБ, таймаут 60 с на запрос, URL аудио не принимает → аудио
  резать на чанки ~10 мин (ffmpeg).

## 7. Отвергнутые альтернативы

- **Агент (dsh / tool-calling) как сборщик** — ТЗ описывает детерминированный
  ETL; агент добавляет недетерминизм и стоимость без выигрыша.
- **Playwright** — не нужен, SSR отдаётся.
- **Postgres + pgvector, Redis + BullMQ** — лишние контейнеры для 20 игр/час.
- **LLM для подбора похожих** — дорого, не масштабируется, хуже эмбеддингов.
- **Агентный выбор летсплея** — оправдан, но отложен; линейная цепочка закрывает ТЗ.

## 8. Знание об инструментах

Проверено 07.09.2026 на Windows 11 / Node 24.14 / pnpm 9.15.

- **`better-sqlite3` пиньится на 12.2.0.** У релиза 13.0.3 на GitHub ноль
  ассетов — prebuild-бинарники не опубликованы, поэтому `prebuild-install`
  проваливается и пакет уходит в `node-gyp rebuild`, требующий Visual Studio.
  У 12.2.0 есть `node-v137-win32-x64` (Node 24) и `node-v137-linuxmusl-x64`
  (Alpine для Docker). Перед повышением версии — проверить наличие ассетов в
  релизе, а не только номер.
- **TypeScript пиньится на 5.9.** `typescript-eslint` 8.x объявляет peer
  `typescript@>=4.8.4 <6.1.0` и с вышедшим TypeScript 7 (компилятор на Go) не
  работает.
- Локальная разработка идёт на Node 24, целевой рантайм в Docker — Node 22
  (`engines: ">=22"`). Обе ABI покрыты prebuild-бинарниками `better-sqlite3`.
