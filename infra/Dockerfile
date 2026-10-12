FROM oven/bun:1.3.12 AS bun-runtime
FROM node:24-bookworm-slim AS builder
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY infra ./infra
RUN bun install --frozen-lockfile
RUN node --import tsx scripts/build.ts

FROM node:24-bookworm-slim AS runtime
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=builder /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/dist ./dist
RUN bun install --production --frozen-lockfile
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && mkdir -p /app/.data/crawlee \
    && chown -R node:node /app/.data
ENV NODE_ENV=production
USER node
CMD ["node", "apps/api/dist/main.mjs"]
