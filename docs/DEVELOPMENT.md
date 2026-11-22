# Development

How to run, configure and work on the project beyond the README's quick start: the environments, the Compose services, running the built app, deploying it, running the gates in Docker, and the devcontainer.

## `pnpm dev`

`pnpm dev` creates the `flashsale_development` database if it is missing, applies migrations, seeds a sale if none exists, builds once, then runs the TypeScript watcher, the API, the worker and the web dev server with labelled output. Ctrl-C stops all of them. It refuses to start if the API port or 5173 is already taken — usually by an earlier `pnpm dev` — rather than leaving a half-started stack.

It assumes each service's stock local credentials, and either can be overridden on its own — in the shell, or once in a `.env` file in the repo root (the shell wins):

| Variable | Default |
| --- | --- |
| `DATABASE_URL` | `postgres://postgres@localhost:5432` — the `postgres` superuser, no password; with no database named, the environment picks it (`flashsale_development`) |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` — RabbitMQ's default user |

If one is not reachable, `pnpm dev` says which and stops, rather than hanging.

## Environments

`APP_ENV` says whose data a process works on, and each environment gets its own on every service — a database in Postgres, a queue and exchange in RabbitMQ — so they can share one Postgres and one broker without touching each other:

| Run | `APP_ENV` | Database | Queue / exchange |
| --- | --- | --- | --- |
| `pnpm dev` | `development` | `flashsale_development` | `development.purchase.attempts` / `development.flash-sale.events` |
| `pnpm test` | `test` | `flashsale_test` | a queue per test, deleted after it |
| `pnpm test:e2e` | `e2e` | `flashsale_e2e` | `e2e.purchase.attempts` / `e2e.flash-sale.events` |
| `pnpm stress` | `stress` | `flashsale_stress` | `stress.purchase.attempts` / `stress.flash-sale.events` |
| deployed | `production` (default) | whatever `DATABASE_URL` names | `purchase.attempts` / `flash-sale.events` |

For the database, `DATABASE_URL` says where Postgres is and who connects; the environment picks the database name unless the URL names one itself, in which case it is used as it is. The dev, test and E2E runs apply that rule; a deployed API and worker take `DATABASE_URL` exactly as given.

It is not `NODE_ENV`, which says how code runs — build mode, React's dev checks. The two vary independently: E2E runs production code against test data. RabbitMQ virtual hosts would be the more literal split, but creating one needs broker admin rights, while queues and exchanges are declared on first use.

## Using the Compose services instead

Without local services, Compose provides both — on non-default ports, so they never clash with ones you do have. Start them and point `pnpm dev` at them via `.env`:

```sh
docker compose up -d --wait
cat >> .env <<'EOF'
DATABASE_URL=postgres://flashsale:flashsale@localhost:15432
RABBITMQ_URL=amqp://flashsale:flashsale@localhost:15673
EOF
pnpm dev
```

Leave the database name off the URL: each environment then picks its own (`flashsale_development` for `pnpm dev`, `flashsale_test` for `pnpm test`), so they never share one. A URL that does name a database is used as it is.

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
| `APP_ENV` | `production` | whose data: names the RabbitMQ queue and exchange — see [Environments](#environments) |
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

## Running the built app without Compose

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

## Deploying behind an ingress or gateway

Nothing here assumes Compose. Two images (`api`, `worker`), a Service for the API, and an HTTPRoute or Ingress sending `/` to it is the whole topology — the API already serves the API, the socket and the SPA on one origin, so there is no reverse proxy to template and no second Deployment to run.

Set **`TRUST_PROXY`** to the gateway's address or CIDR when you do. It decides whether `request.ip` comes from the socket or from `X-Forwarded-For`, and `request.ip` is what the per-IP rate limiter keys on, so it is a security setting:

| `TRUST_PROXY` | `request.ip` | |
| --- | --- | --- |
| unset / `false` | the socket peer | right when clients connect directly |
| `10.0.0.0/8`, `loopback`, … | the client, as reported by a proxy you named | the safe setting behind a gateway |
| `true` | whatever the client sent | the client picks its own rate-limit bucket; only safe if nothing but the gateway can reach the process |

A hop count is **rejected at boot**: Fastify maps a numeric `trustProxy` to a function that trusts nothing, so accepting one would look configured while doing nothing.

To serve the frontend from a CDN or bucket instead, leave `WEB_ROOT` unset and route `/` there. The image is the same.

## Running the gates inside Docker

The `runner` service builds the `test` stage of the `Dockerfile` and reaches the services **by name** over the compose network, so no host port is involved at all:

```sh
docker compose run --build --rm runner              # the whole verify gate
docker compose run --build --rm runner pnpm test    # or any other script
```

**`--build` is not optional.** The image bakes the source at build time, so without it `run` silently reuses the last image and tests your previous edit — which looks exactly like a change that did not work.

`tests/integration/services.test.ts` asserts the services are reachable wherever the suite was pointed. The `Dockerfile` also has `api` and `worker` targets that ship production dependencies only — the images `docker compose --profile app` runs.

## Or use the devcontainer

Both editors read the same `.devcontainer/devcontainer.json`, which builds on the repo's own `docker-compose.yml` — so the development services are not a second copy that can drift from it. Node and pnpm match the versions CI uses, and `pnpm install` runs on create.

- **VS Code** — "Reopen in Container".
- **Zed** — it prompts on opening the project, or run `Project: Open Remote` and choose the dev container. Zed needs Docker or Podman on `PATH`, and does not rebuild automatically after you edit `devcontainer.json`, so stop the container first.

Inside the container the services are reachable by name — `postgres:5432`, `rabbitmq:5672` — already wired up as `DATABASE_URL` and `RABBITMQ_URL`. Host port clashes cannot affect that, because nothing inside goes through the host mapping. The API and web ports are published by Compose rather than left to editor-specific forwarding, so they behave the same in either editor and with no editor at all.

### If the container will not start

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

## Conventions

`CLAUDE.md` holds the housekeeping rules — lint and format gate every commit, no copyleft or known-vulnerable dependencies, one PR at a time. They are enforced in CI, not by convention.

- **Every instant is UTC** from the database to the API boundary, and is localized only in the browser (`docs/PLAN.md` §9.1). CI runs the test suite twice, once under a non-UTC timezone, because a suite that only passes in UTC cannot catch code that depends on the process's local zone.
- **TypeScript is held at 6.0.x**, because `typescript-eslint` peers at `<6.1.0` and TypeScript 7 is already published. Revisit when that peer range moves.
