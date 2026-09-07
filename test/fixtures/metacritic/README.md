# Фикстуры Metacritic

Сняты 07.09.2026 анонимным GET, без apiKey, User-Agent
`mcwatch/0.1 (+https://github.com/mcwatch; fastbs@gmail.com)`.
Парсеры тестируются на них, а не на сети (CLAUDE.md, «Правила кода»).

База: `B = https://backend.metacritic.com`.
Общие параметры `componentName` / `componentType` на ответ не влияют —
сервер их только отражает в `meta`.

| Файл | Запрос | Что показывает |
|---|---|---|
| `finder-new-releases.json` | `B/finder/metacritic/web?sortBy=-releaseDate&metaScoreMin=1&offset=0&limit=20&mcoTypeId=13` | Ровно блок **New Releases** с `/game/`, 20 игр (ТЗ п.1) |
| `finder-browse-p1.json` | `B/finder/metacritic/web?sortBy=-releaseDate&offset=0&limit=24&mcoTypeId=13` | Первая страница **browse** (ТЗ п.2), `totalResults` 177 945 |
| `product-onimusha.json` | `B/games/metacritic/onimusha-way-of-the-sword/web` | Полная карточка: разработчик, издатель, 4 платформы с Metascore, трейлер, жанры, ESRB |
| `product-no-data.json` | `B/games/metacritic/glow-in-the-shadows/web` | Типичный «шлак» из browse: нет описания, видео, ESRB и скоров — все поля `null` |
| `critic-stats.json` | `B/reviews/metacritic/critic/games/<slug>/stats/web` | Сводный Metascore по ведущей платформе |
| `user-stats-pc.json` | `B/reviews/metacritic/user/games/<slug>/platform/pc/stats/web` | Userscore именно платформы PC (9.3), а не ведущей (8.8) |
| `critic-list-ps5.json` | `B/reviews/metacritic/critic/games/<slug>/platform/playstation-5/web?offset=0&limit=50&filterBySentiment=all&sort=score` | Отзывы критиков. `totalResults` 93, отдано **10** — потолок |
| `user-list-pc.json` | `B/reviews/metacritic/user/games/<slug>/platform/pc/web?offset=0&limit=50&filterBySentiment=all&sort=date` | Отзывы пользователей: `id`, `quote`, `score` 0–10, `author`, `spoiler` |
| `critic-list-empty.json` | тот же маршрут для `glow-in-the-shadows` | Отсутствие отзывов: `totalResults` 0, `items` `[]`, не 404 |

Поведение источника, выведенное из этих ответов, — `docs/ARCHITECTURE.md` §6.
Обновлять фикстуры вместе с изменением парсеров, сохраняя точный URL в таблице.
