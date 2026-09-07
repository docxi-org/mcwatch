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

### Metacritic (проверено 07.09.2026, фикстуры в `test/fixtures/metacritic/`)

Все страницы — SSR (Nuxt 3), отдаются анонимным GET без Cloudflare-блока;
браузер не нужен. Но HTML парсить не требуется: под ним лежит открытый
JSON-бэкенд `backend.metacritic.com`, и весь сбор идёт через него.

**apiKey не нужен.** В бандле он есть (`1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u`) и
часть навигационных запросов его несут, но нужные проекту маршруты отвечают
200 и без него. Ключ не хранить и не отправлять.

Параметры `componentName` / `componentType` обязательного смысла не имеют —
сервер отражает их в `meta` ответа и на данные не влияет.

#### Списки: один маршрут на оба пункта ТЗ

`GET /finder/metacritic/web` с `mcoTypeId=13` (13 = игра) и
`sortBy=-releaseDate` покрывает обе выборки — различаются только параметры:

| ТЗ | Параметры | Итог |
|---|---|---|
| п.1 New Releases | `metaScoreMin=1&offset=0&limit=20` | Ровно 20 игр блока New Releases, `totalResults` 18 524 |
| п.2 SEE ALL / browse | без `metaScoreMin`, `limit=24&offset=(N-1)*24` | `totalResults` 177 945 ≈ 7414 страниц |

Эквивалентность п.1 проверена сверкой с SSR-payload `__NUXT_DATA__` страницы
`/game/`: карусель New Releases — тот же список из 20 элементов в том же
порядке. **`metaScoreMin=1` и есть то, что отличает New Releases от browse:**
блок показывает только игры с Metascore.

Элемент списка даёт `slug`, `title`, `releaseDate`, `rating` (ESRB),
`image.bucketType`+`bucketPath`, `criticScoreSummary`, `genres`, `description`,
`userScore`. Разработчика, платформ и видео в списке нет — только на карточке.

Порядок внутри одной календарной даты нестабилен: два запроса того же offset
дают тот же набор в разном порядке. Дедуп по `slug` обязателен, пагинация по
`offset` не гарантирует непересекающиеся страницы.

#### Карточка

`GET /games/metacritic/<slug>/web` → `data.item`:

- `title`, `slug`, `description`, `releaseDate`, `rating`, `genres[].name`;
- `production.companies[]` — разработчик и издатель различаются по
  `typeName` (`Developer` / `Publisher`), одна компания может быть обеими;
- `platforms[]` — по элементу на платформу: `name`, `slug`,
  `criticScoreSummary.score` (Metascore 0–100), `reviewCount`,
  `isLeadPlatform`, `relatedGameId`;
- `video` — `jwPlayerId`, `embedUrl`, `manifestUrl`, `title`, `duration`.
  Ссылку на видео **брать отсюда**, не реконструировать из обложки;
- `images[]` — `typeName` `mainImage` / `cardImage`, плюс `bucketType` и
  `bucketPath`.

**Userscore на карточке нет.** `platforms[]` несёт только оценку критиков.

#### Обложка

URL собирается как `https://www.metacritic.com/a/img/` + `bucketType` +
`bucketPath` — например `.../a/img/catalog/provider/7/2/7-1781631527.jpg`.
Отдаётся оригинал (сотни КБ); параметры вроде `?width=` на этом пути
игнорируются. Форма `/a/img/resize/<hash>/…`, которую использует сайт,
подписана хешем под конкретный размер и из наших данных не собирается.

#### Отзывы и оценки

Оба вида — по одному шаблону, `<kind>` ∈ `critic` | `user`:

```
/reviews/metacritic/<kind>/games/<slug>/stats/web                    сводная оценка
/reviews/metacritic/<kind>/games/<slug>/platform/<platform>/stats/web  то же по платформе
/reviews/metacritic/<kind>/games/<slug>/web                          список (ведущая платформа)
/reviews/metacritic/<kind>/games/<slug>/platform/<platform>/web      список по платформе
```

Список принимает `offset`, `limit`, `sort` (`date` | `score`) и
`filterBySentiment` (`all` | `positive` | `neutral` | `negative`).
**`filterBySentiment` закрывает сбалансированную выборку по тональности из §4.1
на стороне источника** — считать sentiment самим не нужно.

Существенные особенности:

- **Userscore берётся только через `/platform/<slug>/stats/web`.** Сегмент пути
  работает, а одноимённый query-параметр молча игнорируется: без сегмента
  всегда возвращается ведущая платформа. У Onimusha PS5 8.8, PC 9.3 —
  разница реальная, поэтому по каждой платформе нужен свой запрос.
- **Список критиков жёстко отдаёт 10 элементов за запрос**, `limit` игнорируется
  (`limit=50` и `limit=100` дают те же 10). `offset` работает корректно.
  93 отзыва = 10 запросов. Список пользователей `limit` соблюдает
  (проверено до 100).
- **У отзыва критика нет поля `id`** — есть `publicationName`, `publicationSlug`,
  `url`, `date`, `score` 0–100, `quote`. `external_id` схемы для критиков
  придётся выводить детерминированно (кандидат — `publicationSlug` + `url`).
  У отзыва пользователя `id` есть — UUID; плюс `author`, `score` 0–10,
  `quote`, `date`, `spoiler`.
- `reviewCount` в `stats` считает оценки, а не тексты: у Onimusha на PC
  `reviewCount` 18, а текстовых отзывов в списке 8. Как вход правила обновления
  резюме (§4.1) надёжнее длина сохранённого списка, а не `reviewCount`.
- Отсутствие отзывов — не ошибка: `totalResults` 0, `items` `[]`, HTTP 200.

#### Поток browse

Большинство игр browse — мобильный и инди-шлак: без Metascore, часто **без
описания** (`description: null`) и без видео. Эмбеддинг (§4.2) обязан работать
при пустом описании — иначе такие игры выпадут из «похожих».

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
- **HTML-фолбэк к JSON-бэкенду** (решение владельца, 07.09.2026) — не пишем.
  Бэкенд открыт, ключа не требует и отдаёт больше данных, чем страница (видео,
  разбивка по платформам, фильтр по тональности). А главное — фолбэк не был бы
  независимым путём: разметка Metacritic не несёт данных, их пришлось бы брать
  из того же JSON, встроенного в страницу как `__NUXT_DATA__`. Цена — вдвое
  больше кода ради иллюзии второго источника.

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
