# flash-sale

Take-home: a high-throughput flash sale system. `docs/REQUIREMENT.md` is the brief, `docs/PLAN.md` is the design and its open questions, `docs/prototype/` holds the spikes that settled the measurable ones.

## Code hygiene

- **Lint and format gate every commit.** `pnpm lint` and `pnpm format:check` run in CI and fail the build. Neither is advisory, and neither gets a `--no-verify`.
- **ESLint** flat config with `typescript-eslint`. Pin `settings.react.version` explicitly rather than relying on auto-detect, which breaks on recent ESLint majors. Confirm `typescript-eslint` supports a TypeScript major before bumping onto it.
- **Prettier owns formatting; ESLint owns correctness.** No stylistic rules in ESLint, no `eslint-plugin-prettier`. One tool per job keeps the failures legible.
- **Type checking is part of the gate.** `tsc --noEmit` in CI, `strict: true`, no `any` without a comment saying why.

## Dependencies

- **No known-vulnerable dependencies.** `pnpm audit --audit-level=high` runs in CI and fails the build. Fix it or justify it in the PR; never silence it.
- **No prerelease direct dependencies** — no `rc`, `beta` or `alpha`.
- **Prefer `^` ranges.** Pin exactly only when something concrete forces it, and say what in the PR.
- **Lockfile is committed.** CI installs with `--frozen-lockfile`.

## Pull requests

- **One PR at a time.** Never open a second PR against the same base while one is open. Queue the next change or fold it into the current PR.
- **Always prompt for review** when a PR is opened or updated, then wait. Silence is not approval, and neither is a green build.
- **One change per PR.** The phases in `docs/PLAN.md` §13 are a reasonable PR boundary.
- Rebase onto the base branch; never merge the base into a topic branch.
