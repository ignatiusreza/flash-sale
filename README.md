# flash-sale

A high-throughput flash sale backend: one product, limited stock, one item per user, under heavy concurrent load.

`docs/REQUIREMENT.md` is the brief. **`docs/PLAN.md` is the design**, including the trade-offs and the open questions. `docs/prototype/` holds the spikes that settled the measurable ones — each records how to reproduce its numbers.

> **Status: phase 0 of 8.** Scaffolding and CI gates only. The claim core, queue, API, WebSocket layer and frontend land in phases 1–5; see `docs/PLAN.md` §13.

## Requirements

- Node >= 24
- pnpm (via `corepack enable`)
- Docker, for Postgres and RabbitMQ

## Getting started

```sh
pnpm install
docker compose up -d --wait   # Postgres + RabbitMQ
pnpm verify                   # format, lint, typecheck, test, licences, audit
```

If ports 5432 or 5672 are already taken on your machine, override them — Compose reads a `.env` file in the repo root, so this can be set once rather than on every command:

```sh
POSTGRES_PORT=5433 RABBITMQ_PORT=5673 RABBITMQ_UI_PORT=15673 docker compose up -d --wait
```

### Or use the devcontainer

Both editors read the same `.devcontainer/devcontainer.json`, which builds on the repo's own `docker-compose.yml` — so the development services are not a second copy that can drift from it. Node and pnpm match the versions CI uses, and `pnpm install` runs on create.

- **VS Code** — "Reopen in Container".
- **Zed** — it prompts on opening the project, or run `Project: Open Remote` and choose the dev container. Zed needs Docker or Podman on `PATH`, and does not rebuild automatically after you edit `devcontainer.json`, so stop the container first.

Inside the container the services are reachable by name — `postgres:5432`, `rabbitmq:5672` — already wired up as `DATABASE_URL` and `RABBITMQ_URL`. Host port clashes cannot affect that, because nothing inside goes through the host mapping. The API and web ports are published by Compose rather than left to editor-specific forwarding, so they behave the same in either editor and with no editor at all.

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

## Conventions

`CLAUDE.md` holds the housekeeping rules — lint and format gate every commit, no copyleft or known-vulnerable dependencies, one PR at a time. They are enforced in CI, not by convention.

Two worth knowing up front:

- **Every instant is UTC** from the database to the API boundary, and is localized only in the browser (`docs/PLAN.md` §9.1). CI runs the test suite twice, once under a non-UTC timezone, because a suite that only passes in UTC cannot catch code that depends on the process's local zone.
- **TypeScript is held at 6.0.x**, because `typescript-eslint` peers at `<6.1.0` and TypeScript 7 is already published. Revisit when that peer range moves.
