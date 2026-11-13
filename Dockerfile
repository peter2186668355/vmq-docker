FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/web/package.json apps/web/package.json
RUN corepack pnpm --filter @vmq/admin --filter @vmq/web install --frozen-lockfile --ignore-scripts
COPY apps ./apps
COPY public ./public
RUN corepack pnpm --filter @vmq/admin build && corepack pnpm --filter @vmq/web build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 SQLITE_PATH=/app/data/vmq.sqlite
RUN install -d -m 0700 -o node -g node /app/data
COPY --from=build /app/public ./public
COPY src ./src
COPY docker ./docker
COPY package.json schema.sql ./
USER node
EXPOSE 8787
CMD ["node", "--import", "./docker/ts-import-hook.mjs", "./docker/server.mjs"]
