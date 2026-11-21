# flash-sale

A high-throughput flash sale backend: one product, limited stock, one item per user, under heavy concurrent load.

`docs/REQUIREMENT.md` is the brief. **`docs/PLAN.md` is the design**, including the trade-offs and the open questions. `docs/prototype/` holds the spikes that settled the measurable ones — each records how to reproduce its numbers.

> **Status: phase 4 of 8.** The claim, the queue, the HTTP API and the realtime layer are implemented and tested; the frontend lands in phase 5. See `docs/PLAN.md` §13.

## API

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/sale` | status, coarse availability, window, `serverTime` — served from memory, no I/O |
| `POST` | `/api/purchase` | `202 queued` once the broker confirms · `409` not started / ended / sold out · `429` · `503` busy |
| `GET` | `/api/purchase/:userId` | the user's order, or `none` — the reconnect source of truth |
| `GET` | `/healthz` `/readyz` | live as soon as the process is up; ready only once the sale is loaded |

Interactive docs are served at **`/docs`**, with the OpenAPI document at `/docs/json`. The route schemas generate it, and Fastify compiles the same schemas for validation and response serialization — so documenting the API also makes it marginally faster.

`POST /api/purchase` answers **202, not 200**: the outcome arrives over the socket. It returns only after the broker has confirmed the publish, which is what makes that promise keepable — an unconfirmed publish could vanish and leave the user waiting forever.

## The claim

`apps/worker/src/claim.ts` is the heart of the system: a single SQL statement that claims up to N units in arrival order, decrementing stock by the rows it *actually* inserted rather than by the batch size — which is what makes a redelivered batch a no-op instead of silently destroying stock.

Two tests in `apps/worker/src/claim.test.ts` are the ones that matter, and both run in CI against a real Postgres:

- **never oversells** — 20 000 attempts against stock of 1000 yields exactly 1000 grants, 1000 distinct users, and `remaining` at 0.
- **never grants one user two units** — 500 concurrent attempts from a single user yield exactly one order.

The first asserts on grants *returned to callers* as well as rows in the table. Both halves are needed: `docs/prototype/postgres-pool/` contains a claim that oversells 9.5× while leaving the table immaculate, so a row-count assertion alone would pass it.

## Requirements

- Node >= 24
- pnpm (via `corepack enable`)
- Docker, for Postgres and RabbitMQ

## Getting started

```sh
pnpm install
docker compose up -d --wait   # Postgres + RabbitMQ
pnpm dev                      # everything else
```

`pnpm dev` is the whole stack: it discovers the service ports from Compose, builds once, applies migrations, seeds a sale if none exists, then runs the TypeScript watcher, the API, the worker and the web dev server with labelled output. Ctrl-C stops all of them.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `SEED_STOCK` | `100` | units in the seeded sale |
| `SEED_DURATION_MINUTES` | `60` | how long it stays open |
| `SEED_RESET` | — | `1` to recreate the sale and drop its orders |

Seeding is idempotent, so restarting never resets stock out from under whatever you were testing.

```sh
pnpm verify                   # format, lint, typecheck, test, licences, audit
```

The services are published on **non-default host ports**, so they cannot clash with a Postgres or RabbitMQ already running on your machine:

| Service | Host | Override |
| --- | --- | --- |
| Postgres | `15432` | `POSTGRES_PORT` |
| RabbitMQ | `15673` | `RABBITMQ_PORT` |
| RabbitMQ management UI | `15674` | `RABBITMQ_UI_PORT` |

Compose reads a `.env` file in the repo root, so an override can be set once rather than on every command.

They are *published* rather than left ephemeral on purpose: Zed's dev-container support parses `docker compose config` with a deserializer that requires a `published` field on every port, and an unpublished port omits it — the container then fails to start with a YAML deserialization error.

### Running the gates inside Docker

The `runner` service builds the `test` stage of the `Dockerfile` and reaches the services **by name** over the compose network, so no host port is involved at all:

```sh
docker compose run --build --rm runner              # the whole verify gate
docker compose run --build --rm runner pnpm test    # or any other script
```

**`--build` is not optional.** The image bakes the source at build time, so without it `run` silently reuses the last image and tests your previous edit — which looks exactly like a change that did not work.

`tests/integration/services.test.ts` asserts exactly that — it is skipped on a bare checkout and runs here. The `Dockerfile` also has `api` and `worker` targets that ship production dependencies only; neither has a server to run until phases 2–4.

### Or use the devcontainer

Both editors read the same `.devcontainer/devcontainer.json`, which builds on the repo's own `docker-compose.yml` — so the development services are not a second copy that can drift from it. Node and pnpm match the versions CI uses, and `pnpm install` runs on create.

- **VS Code** — "Reopen in Container".
- **Zed** — it prompts on opening the project, or run `Project: Open Remote` and choose the dev container. Zed needs Docker or Podman on `PATH`, and does not rebuild automatically after you edit `devcontainer.json`, so stop the container first.

Inside the container the services are reachable by name — `postgres:5432`, `rabbitmq:5672` — already wired up as `DATABASE_URL` and `RABBITMQ_URL`. Host port clashes cannot affect that, because nothing inside goes through the host mapping. The API and web ports are published by Compose rather than left to editor-specific forwarding, so they behave the same in either editor and with no editor at all.

#### If the container will not start

`Bind for 0.0.0.0:3000 failed: port is already allocated` almost always means another copy of this project still has a container running — editors leave the Compose stack up when the window closes, so a session you finished hours ago can still hold the port. Find it and stop it:

```sh
docker ps --format '{{.Names}}\t{{.Ports}}' | grep 3000
docker stop <name>                      # reversible; volumes are untouched
```

Only one checkout can hold 3000 and 5173 at a time. To run two side by side — a worktree alongside the main checkout — give one of them its own ports in a `.env`:

```sh
API_PORT=3100
WEB_PORT=5174
POSTGRES_PORT=15442
RABBITMQ_PORT=15683
RABBITMQ_UI_PORT=15684
```

Editor configuration is split by necessity: `.zed/settings.json` and `.zed/tasks.json` for Zed, `customizations.vscode` inside `devcontainer.json` for VS Code. Both set the same thing — Prettier owns formatting, ESLint fixes on save — so the gates behave identically whichever you use.

## Layout

| Path            | What it is                                                                               |
| --------------- | ---------------------------------------------------------------------------------------- |
| `packages/core` | Shared contracts and domain logic. No Node globals — it is bundled into the browser too. |
| `apps/api`      | Fastify server and Socket.IO. Phases 3–4.                                                |
| `apps/worker`   | Queue consumer and the transactional claim. Phases 1–2.                                  |
| `apps/web`      | Vite + React client. Phase 5.                                                            |
| `tests/`        | `integration/` (Vitest), `e2e/` (Playwright), `stress/` (k6).                            |
| `scripts/`      | Repo tooling, including the licence gate.                                                |

## Scripts

| Command                     | Does                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `pnpm verify`               | Everything CI runs, in CI's order. Run this before pushing. |
| `pnpm build`                | `tsc -b` across the project graph, then the web bundle.     |
| `pnpm typecheck`            | Build graph, test files, and the web app.                   |
| `pnpm test`                 | Vitest.                                                     |
| `pnpm lint` / `pnpm format` | ESLint / Prettier.                                          |
| `pnpm licenses:check`       | Fails on any dependency licence outside the allowlist.      |
| `pnpm clean`                | Removes build output.                                       |

## Realtime

Clients connect a Socket.IO socket identifying themselves with a `userId`, and receive:

| Event | When |
| --- | --- |
| `purchase:result` | their attempt is settled — `confirmed`, `already_purchased`, `sold_out`, `not_started` or `ended` |
| `sale:status` | on connect, and whenever status or availability changes |
| `sale:viewers` | periodically, with the aggregated viewer count |

**Every API instance receives every result** from the RabbitMQ fanout and delivers only to the sockets it holds. That is deliberate: a result targets exactly one user, so no shared adapter and no user-to-instance registry is needed — the cost of the extra fan-out is bounded by the request rate (`docs/PLAN.md` §8).

**The viewer count is aggregated, not exact.** Each instance announces its own socket count on a timer and every instance sums what it has heard, expiring instances that go quiet. It converges within an announcement interval rather than being instantaneous, which is the right trade for a decorative number — exact accounting broadcast to everyone would be O(N²).

A socket that does not identify itself is refused during the handshake: nothing could ever be routed to it.

### The same user in several tabs

Results are delivered **per user, not per attempt**, so every tab a user has open — on any instance — receives every result for that user, including attempts it did not make itself. That is deliberate: a tab that never clicked Buy still learns its user now holds an order, instead of showing a stale "not purchased".

The consequence a client must handle: if two tabs each attempt, every tab sees both outcomes — one `confirmed` and one `already_purchased` — and a client keying on the newest event would flip between them. **Both carry the same `orderId`**, so a client should key on that rather than on which attempt won. The two statuses mean the same thing to a user: you hold an order.

The viewer count is distinct users rather than sockets, so three tabs are one viewer. That dedupes within an instance only — the same user connected to two instances counts twice, which closing would need the shared registry this design avoids.

## Conventions

`CLAUDE.md` holds the housekeeping rules — lint and format gate every commit, no copyleft or known-vulnerable dependencies, one PR at a time. They are enforced in CI, not by convention.

Two worth knowing up front:

- **Every instant is UTC** from the database to the API boundary, and is localized only in the browser (`docs/PLAN.md` §9.1). CI runs the test suite twice, once under a non-UTC timezone, because a suite that only passes in UTC cannot catch code that depends on the process's local zone.
- **TypeScript is held at 6.0.x**, because `typescript-eslint` peers at `<6.1.0` and TypeScript 7 is already published. Revisit when that peer range moves.
