# AGENTS.md

Instructions for coding agents. The source of truth is `QuickstartRot — Build Spec.pdf` (text copy: `docs/SPEC.md`). If this file and the spec disagree, the spec wins. Do not change schemas in `packages/core` without saying why.

## Conventions (spec section 4)

- Strict TypeScript, no `any`. Every boundary (HTTP body, YAML file, LLM output, runner result) is parsed with a Zod schema from `packages/core`.
- Packages `crawler`, `compiler`, `executor`, `classifier`, `status` contain no HTTP server code and no database access. They are pure libraries with injected dependencies, so the `cli` and the workflow can both call them.
- Only `apps/api` writes to the database. Runners never hold database credentials.
- `status` is pure functions: `evaluate(state, run, ctx) -> { next, events }` (spec: `evaluate(tool, run, cycleValid)`; the context carries `cycleValid` and the incident facts). 100% unit-test coverage on it, and on `classifier`.
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

## Compiler cache rule

`COMPILER_VERSION` (packages/compiler/src/prompt.ts) is part of the plan cache key. Bump it whenever anything that changes a compiled plan changes: the system prompt (a test pins its hash), the block selection (`select.ts`: it decides what the model sees) or any pass in the compile pipeline (quarantine, content fill, finalize, validator). `packages/compiler/src/grounding` must stay at 100% coverage.

## Writing source files with escapes

Backslash escapes (`\n`, `\S`, `​`) in Bash heredocs and some write paths get mangled. Prefer Edit/Write for code containing them and re-read the result. `packages/core/src/hygiene.test.ts` fails the build if hidden Unicode characters reach the repo.

## Docker tests and the sandbox

`packages/executor` and the canary test in `packages/cli` run against the real Docker daemon. They skip without Docker unless `QSR_REQUIRE_DOCKER=1` (set in `ci.yml`); `QSR_SKIP_DOCKER_TESTS=1` skips them on purpose. Never pass host environment to the container (`buildRunArgs` has no `-e`, volumes or privileges, and a test pins that). Never write files into the container with `docker cp` (it creates root-owned files). Later-phase notes live in `docs/NOTES.md`.

## API tests and the database

`apps/api` integration tests run against a throwaway Postgres (`docker compose -f docker-compose.test.yml up -d --wait`, then `QSR_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/qsr_test`), never Supabase, and apply every migration themselves. They skip without the variable unless `QSR_REQUIRE_DB=1` (set in `ci.yml`). The live-Supabase RLS tests in `packages/db` stay gated behind secrets. Never edit an applied migration: add a new one and apply it with `pnpm --filter @qsr/db db:migrate`. `src/budget.ts` in `apps/api` and the HMAC verifier in `core` stay at 100% coverage. `DEPLOY.md` is the ordered Render checklist.

## Secret gate (pre-commit)

`pnpm secrets:check` scans the STAGED changes with gitleaks (a local binary, else the pinned Docker image) and exits non-zero on any finding, or when it cannot run (it fails closed). Husky runs it from `.husky/pre-commit`; `pnpm test:scripts` proves it blocks (a fake token staged in a scratch repo, and a real `git commit` refused). Never work around it by allowlisting a real value: `.gitleaks.toml` allowlists only documented placeholders. CI also scans the full history.

## Classifier fixtures

A new classifier rule starts with a fixture (`packages/classifier/fixtures/`; `node scripts/capture-classifier-fixtures.mjs` captures real ones in Docker). A test fails if a rule has no fixture.
