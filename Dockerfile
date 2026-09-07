# syntax=docker/dockerfile:1

# Node 22 — зафиксированное решение (CLAUDE.md). Alpine годится: у
# better-sqlite3 12.2.0 есть prebuild node-v127-linuxmusl-x64, поэтому
# компилятор в образе не нужен (docs/ARCHITECTURE.md §8).
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
# Фронт собирается здесь же: `pnpm build` — это vite и следом tsc.
COPY web ./web
RUN pnpm build

FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Свой пользователь: процесс не должен работать от root.
RUN addgroup -S app && adduser -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Миграции нужны в рантайме: сервер накатывает их при старте.
COPY drizzle ./drizzle
# Собранный фронт. Берётся из стадии сборки, а не из контекста: в образ
# обязана попасть та статика, что собрана здесь, а не случайно лежавшая рядом.
COPY --from=build --chown=app:app /app/web/dist ./web/dist

# Том для файла SQLite. Каталог создаётся заранее с нужным владельцем,
# иначе том примонтируется от root и запись упадёт.
RUN mkdir -p /app/data && chown -R app:app /app/data
VOLUME ["/app/data"]

USER app
EXPOSE 3000
ENV DATABASE_PATH=/app/data/mcwatch.db

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
