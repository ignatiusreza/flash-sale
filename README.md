# flash-sale

A high-throughput flash sale backend: one product, limited stock, one item per user, under heavy concurrent load.

`docs/REQUIREMENT.md` is the brief. **`docs/PLAN.md` is the design**, including the trade-offs and the open questions. `docs/prototype/` holds the spikes that settled the measurable ones — each records how to reproduce its numbers.

> **Status: phase 5 of 8.** The system works end to end — claim, queue, API, realtime and frontend. Remaining: E2E tests, stress tests and the write-up. See `docs/PLAN.md` §13.

## API

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/sale` | status, coarse availability, window, `serverTime` — served from memory, no I/O |
| `POST` | `/api/orders` | create — `202 queued` once the broker confirms, `Location` → the user's orders · `409` not started / ended / sold out · `429` · `503` busy |
| `GET` | `/api/orders?userId=` | index, filtered by user — `[]` or the user's one order; `400` without the filter — the reconnect source of truth |
| `GET` | `/healthz` `/readyz` | live as soon as the process is up; ready only once the sale is loaded |

Interactive docs are served at **`/docs`**, with the OpenAPI document at `/docs/json`. The route schemas generate it, and Fastify compiles the same schemas for validation and response serialization — so documenting the API also makes it marginally faster.

Orders are a REST resource with two of the seven conventional actions, `index` and `create`. `new` and `edit` are server-rendered forms a single-page app has no use for, and an order cannot be changed or cancelled once claimed, so there is no `update` or `destroy`. A reconnecting client knows who it is but not its order id, so it lists its orders by user — a filtered `index` that returns zero or one entries. The filter is required: unfiltered, `index` would list every buyer to anyone while there is no authentication. Nothing needs `show` yet; it would be `GET /api/orders/:orderId`.

`POST /api/orders` answers **202 Accepted, not 201 Created**: the order is accepted for creation, and the outcome arrives over the socket. It returns only after the broker has confirmed the publish, which is what makes that promise keepable — an unconfirmed publish could vanish and leave the user waiting forever.

## Vocabulary

Four words, kept distinct in code, the API and the messages:

| Word | Means | In code |
| --- | --- | --- |
| **purchase** | the act — what a user does by pressing *Buy now*, which asks for an order to be created | `purchase()`, `canPurchase`, `purchaseState` (where this user's purchasing stands) |
| **attempt** | one queued request that a purchase produces; it may or may not succeed | `PurchaseAttempt`, `attemptId`, queue `purchase.attempts` |
| **result** | the worker's decision on an attempt | `PurchaseResult`, `purchase:result`; `confirmed`, `already_purchased`, `sold_out`, `not_started`, `ended` |
| **order** | the row a successful attempt leaves behind — the only durable proof of a sale | `/api/orders`, `orders` table, `orderId`, `findOrder` |

*Buy* is the button's wording, not a term in the code.

## The claim

`apps/worker/src/claim.ts` is the heart of the system: a single SQL statement that claims up to N units in arrival order, decrementing stock by the rows it *actually* inserted rather than by the batch size — which is what makes a redelivered batch a no-op instead of silently destroying stock.

Two tests in `apps/worker/src/claim.test.ts` are the ones that matter, and both run in CI against a real Postgres:

- **never oversells** — 20 000 attempts against stock of 1000 yields exactly 1000 grants, 1000 distinct users, and `remaining` at 0.
- **never grants one user two units** — 500 concurrent attempts from a single user yield exactly one order.

The first asserts on grants *returned to callers* as well as rows in the table. Both halves are needed: `docs/prototype/postgres-pool/` contains a claim that oversells 9.5× while leaving the table immaculate, so a row-count assertion alone would pass it.

## Requirements

- Node >= 24
- pnpm (via `corepack enable`)
- Postgres and RabbitMQ — already on your machine, or from Docker Compose

## Getting started

With a Postgres and RabbitMQ already running locally:

```sh
pnpm install
pnpm dev        # http://localhost:5173
```

That is the whole setup. `pnpm dev` creates the `flashsale_development` database if it is missing, applies migrations, seeds a sale if none exists, builds once, then runs the TypeScript watcher, the API, the worker and the web dev server with labelled output. Ctrl-C stops all of them.

It assumes each service's stock local credentials, and either can be overridden on its own — in the shell, or once in a `.env` file in the repo root (the shell wins):

| Variable | Default |
| --- | --- |
| `DATABASE_URL` | `postgres://postgres@localhost:5432/flashsale_development` — the `postgres` superuser, no password |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` — RabbitMQ's default user |

If one is not reachable, `pnpm dev` says which and stops, rather than hanging.

### Using the Compose services instead

Without local services, Compose provides both — on non-default ports, so they never clash with ones you do have. Start them and point `pnpm dev` at them via `.env`:

```sh
docker compose up -d --wait
cat >> .env <<'EOF'
DATABASE_URL=postgres://flashsale:flashsale@localhost:15432/flashsale
RABBITMQ_URL=amqp://flashsale:flashsale@localhost:15673
EOF
pnpm dev
```

To see the whole thing running, built and containerised, with nothing on the host but Docker:

```sh
docker compose --profile app up -d --wait   # everything, built
open http://localhost:8080
```

The application services sit behind a Compose profile so they do not start by default — `pnpm dev` runs them on the host, and the two would otherwise fight over the same ports.

There are only two application services, `api` and `worker`. The API serves the HTTP API, the WebSocket *and* the built frontend on one origin, so it is the only one publishing a port. Routing a browser between a SPA and an API is a deployment concern, left to whatever is already in front — an Ingress or HTTPRoute under Kubernetes, a CDN in production, the Vite proxy in development (docs/PLAN.md §12.1).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `WEB_ROOT` | — | directory of the built SPA; unset, the process is a pure API |
| `TRUST_PROXY` | `false` | whose `X-Forwarded-For` to believe — see below |
| `SEED_STOCK` | `100` | units in the seeded sale |
| `SEED_DURATION_MINUTES` | `60` | how long it stays open |
| `SEED_RESET` | — | `1` to recreate the sale and drop its orders |

Seeding is idempotent, so restarting never resets stock out from under whatever you were testing.

```sh
pnpm verify                   # format, lint, typecheck, test, licences, audit
```

`pnpm test` uses the same local defaults and `.env` as `pnpm dev`, against a separate `flashsale_test` database (created if missing) so a test run never writes into the data you are clicking through. If no URL is set and nothing is listening on the default port, the suites that need that service skip with a warning, so a checkout with no services still runs the unit tests. A URL you set explicitly has to be reachable, or those suites fail.

The Compose services are published on **non-default host ports**, so they cannot clash with a Postgres or RabbitMQ already running on your machine:

| Service | Host | Override |
| --- | --- | --- |
| Postgres | `15432` | `POSTGRES_PORT` |
| RabbitMQ | `15673` | `RABBITMQ_PORT` |
| RabbitMQ management UI | `15674` | `RABBITMQ_UI_PORT` |
| Application (`--profile app`) | `8080` | `APP_PORT` |

Compose reads a `.env` file in the repo root, so an override can be set once rather than on every command.

They are *published* rather than left ephemeral on purpose: Zed's dev-container support parses `docker compose config` with a deserializer that requires a `published` field on every port, and an unpublished port omits it — the container then fails to start with a YAML deserialization error.

### Running the built app without Compose

`pnpm dev` is for working on the code. The built app is two plain Node processes needing nothing but a Postgres and a RabbitMQ they can reach, which is how a deployment runs it:

```sh
pnpm build
export DATABASE_URL=postgres://postgres@localhost:5432/flashsale
export RABBITMQ_URL=amqp://guest:guest@localhost:5672
pnpm migrate                                        # schema (the database must exist)
pnpm seed                                           # a sale to buy from
node apps/worker/dist/index.js &                    # the claim worker
WEB_ROOT=apps/web/dist node apps/api/dist/index.js  # API + frontend on :3000
```

### Deploying behind an ingress or gateway

Nothing here assumes Compose. Two images (`api`, `worker`), a Service for the API, and an HTTPRoute or Ingress sending `/` to it is the whole topology — the API already serves the API, the socket and the SPA on one origin, so there is no reverse proxy to template and no second Deployment to run.

Set **`TRUST_PROXY`** to the gateway's address or CIDR when you do. It decides whether `request.ip` comes from the socket or from `X-Forwarded-For`, and `request.ip` is what the per-IP rate limiter keys on, so it is a security setting:

| `TRUST_PROXY` | `request.ip` | |
| --- | --- | --- |
| unset / `false` | the socket peer | right when clients connect directly |
| `10.0.0.0/8`, `loopback`, … | the client, as reported by a proxy you named | the safe setting behind a gateway |
| `true` | whatever the client sent | the client picks its own rate-limit bucket; only safe if nothing but the gateway can reach the process |

A hop count is **rejected at boot**: Fastify maps a numeric `trustProxy` to a function that trusts nothing, so accepting one would look configured while doing nothing.

To serve the frontend from a CDN or bucket instead, leave `WEB_ROOT` unset and route `/` there. The image is the same.

### Running the gates inside Docker

The `runner` service builds the `test` stage of the `Dockerfile` and reaches the services **by name** over the compose network, so no host port is involved at all:

```sh
docker compose run --build --rm runner              # the whole verify gate
docker compose run --build --rm runner pnpm test    # or any other script
```

**`--build` is not optional.** The image bakes the source at build time, so without it `run` silently reuses the last image and tests your previous edit — which looks exactly like a change that did not work.

`tests/integration/services.test.ts` asserts the services are reachable wherever the suite was pointed. The `Dockerfile` also has `api` and `worker` targets that ship production dependencies only; neither has a server to run until phases 2–4.

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
| `pnpm test`                 | Vitest, against local services by default (see above).      |
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
