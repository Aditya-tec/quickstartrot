# AGENTS.md

Instructions for coding agents. The source of truth is `QuickstartRot — Build Spec.pdf` (text copy: `docs/SPEC.md`). If this file and the spec disagree, the spec wins. Do not change schemas in `packages/core` without saying why.

## Conventions (spec section 4)

- Strict TypeScript, no `any`. Every boundary (HTTP body, YAML file, LLM output, runner result) is parsed with a Zod schema from `packages/core`.
- Packages `crawler`, `compiler`, `executor`, `classifier`, `status` contain no HTTP server code and no database access. They are pure libraries with injected dependencies, so the `cli` and the workflow can both call them.
- Only `apps/api` writes to the database. Runners never hold database credentials.
- `status` is pure functions: `(previousState, newRunResult) -> { nextState, events }`. 100% unit-test coverage on it.
- All time in UTC, ISO 8601 strings at boundaries, `timestamptz` in Postgres.
- Every log line is JSON via pino with `runId`, `toolSlug`, `stepId` fields where applicable.
- No secret ever appears in a log, artifact or LLM prompt. A redaction helper in `core` runs over all captured output.
- Each package has a `README.md` with its public API and an example.
- Conventional commits, one PR per phase, CI green before merge.

## Trust rules that must never be broken

- The LLM never writes code. Only verbatim docs code runs (grounding validator, spec section 8).
- The `execute` job in `probe.yml` has no secrets, `permissions: {}`, `persist-credentials: false`, and never calls the API. CI greps `probe.yml` and fails if the execute job references `secrets.`.
- Nothing is public BROKEN without two consecutive failures in valid cycles and human review.
- A cycle whose canaries misbehave is `valid = false` and ignored by the status engine.
- Respect robots.txt; never automate signups, solve CAPTCHAs, or use real vendor API keys in v1.

## Build phases (spec section 15)

One phase per PR, do not start a phase until the previous one meets its acceptance criteria. Write the acceptance tests first.
P0 Foundations, P1 Core schemas + DB, P2 Crawler + fixtures, P3 Compiler + grounding validator, P4 Executor + sandbox images, P5 Classifier + status engine, P6 API, P7 Probe pipeline, P8 Web, P9 Scale and calibrate, P10 Disclosure and launch.

## Commands

`pnpm install` · `pnpm build` · `pnpm typecheck` · `pnpm test` · `pnpm lint` · `pnpm format:check`
