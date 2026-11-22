# Multi-stage build. Targets:
#   test    — runs the gates against the compose services (`runner` in compose)
#   api     — the API server, which also serves the built SPA
#   worker  — the queue consumer
#
# Dependency manifests are copied before the sources so that editing a source
# file does not invalidate the install layer.

FROM node:24-bookworm-slim AS base
ENV TZ=UTC \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app

# ---- dependencies -----------------------------------------------------------

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------

FROM deps AS build
COPY . .
RUN pnpm build

# ---- test -------------------------------------------------------------------
# Keeps dev dependencies, so the whole `verify` gate runs here exactly as CI
# runs it. Reaches Postgres and RabbitMQ by service name over the compose
# network; no host port is involved.

FROM build AS test
CMD ["pnpm", "verify"]

# ---- runtime ----------------------------------------------------------------
# `pnpm deploy` resolves the workspace package into a self-contained directory
# with production dependencies only.

FROM build AS prune-api
RUN pnpm --filter @flash-sale/api deploy --prod --legacy /out

FROM base AS api
ENV NODE_ENV=production \
    WEB_ROOT=/app/public
COPY --from=prune-api /out /app
# The built SPA ships with the API, which serves it on the same origin. Unset
# WEB_ROOT to run this as a pure API and let a CDN or the gateway serve the
# frontend instead (docs/PLAN.md §12.1).
COPY --from=build /app/apps/web/dist /app/public
USER node
CMD ["node", "dist/index.js"]

FROM build AS prune-worker
RUN pnpm --filter @flash-sale/worker deploy --prod --legacy /out

FROM base AS worker
ENV NODE_ENV=production
COPY --from=prune-worker /out /app
USER node
CMD ["node", "dist/index.js"]
