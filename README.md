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

If ports 5432 or 5672 are already taken on your machine, override them:

```sh
POSTGRES_PORT=5433 RABBITMQ_PORT=5673 RABBITMQ_UI_PORT=15673 docker compose up -d --wait
```

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
