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

## Workflows (P7)

- Every `uses:` is pinned to a full 40-character commit SHA with its version in a comment. Resolve a new one with
  `git ls-remote --tags https://github.com/<owner>/<repo>` (take the peeled `^{}` commit of an annotated tag) and check it
  with `GET /repos/<owner>/<repo>/commits/<sha>`; never write a SHA from memory. `packages/cli/src/workflows.test.ts` fails
  the build on an unpinned action.
- `probe.yml` splits trust: `plan` and `report` have the secrets, `execute` has none (no `secrets.`, no `vars.`, `permissions: {}`,
  checkout with `persist-credentials: false`), and only `report` may have `issues: write`. Only `snapshot.yml` may have `contents: write`.
  No workflow uses `pull_request_target`, and no `run:` block interpolates event data or inputs (pass them through `env:`).
- `packages/cli/src/probe/execute.ts` and `execute-command.ts` must not import the API client or read API settings (a test pins it).
- CI runs actionlint (pinned image) over `.github/workflows/*.yml`; a finding fails the build. Run it locally the same way.
- `pnpm probe:local` runs plan -> execute -> report against a local API and Postgres before anything is deployed.

## Website (P8)

- `apps/web` reads only the public views, through `DataSource` (`QSR_DATA=fixtures` for seeded data). Pages never import supabase-js and never receive a raw row: they get view models from `src/lib/service.ts`.
- **An unreviewed failure shows "verifying" and no cause anywhere** (HTML, RSC payload, badge, image, JSON). `publicStatus`, `confirmedOnly` and `sanitizeRun` (`@qsr/core/public`) are the only way to a status or a run, and the fixtures contain poisoned rows on purpose. `e2e/leak.spec.ts` must stay green; never weaken it.
- No `dangerouslySetInnerHTML`, `innerHTML` or similar anywhere in `apps/web` (lint rule in `eslint.config.js` and `src/lib/no-raw-html.test.ts`). Logs and diffs are rendered as React text.
- Client components import `@qsr/core/public`, never `@qsr/core` (the main entry has Node built-ins).
- The admin token and the API address are read only on the server (server actions, route handlers). `/admin` is guarded by the middleware and each action re-checks the session.
- Web tests: `pnpm --filter @qsr/web test` (vitest) and `pnpm --filter @qsr/web test:e2e` (Playwright and axe against `next build`, fixtures and a stub API; build first). New pages must be added to `e2e/pages.ts`, which feeds the axe, leak and screenshot specs. The e2e suite is a CI step.
- `.next/cache` survives rebuilds: delete `apps/web/.next` when switching between fixture and live data locally.

## Secret gate (pre-commit)

`pnpm secrets:check` scans the STAGED changes with gitleaks (a local binary, else the pinned Docker image) and exits non-zero on any finding, or when it cannot run (it fails closed). Husky runs it from `.husky/pre-commit`; `pnpm test:scripts` proves it blocks (a fake token staged in a scratch repo, and a real `git commit` refused). Never work around it by allowlisting a real value: `.gitleaks.toml` allowlists only documented placeholders. CI also scans the full history.

## Classifier fixtures

A new classifier rule starts with a fixture (`packages/classifier/fixtures/`; `node scripts/capture-classifier-fixtures.mjs` captures real ones in Docker). A test fails if a rule has no fixture.

## Targets and plans (P9a)

- A target is enabled only after `qsr run <slug>` in real Docker gave an explainable result and you read the log (`docs/TARGET-SELECTION.md` has the criteria and the full candidate table). Draft with `scripts/probe-docs-page.mjs` and `scripts/draft-target.mjs` (they start `enabled: false`), run with `scripts/batch-run.mjs`, record with `scripts/set-target.mjs` / `scripts/apply-run-result.mjs`, then `node scripts/render-target-selection.mjs`. Take `owners` only from the vendor's own docs or repo. `chalk`, `loguru` and `dotenv` are calibration targets only; `hono-node` is the deliberate "needs a person" example.
- `qsr plans push <slug>|--all` sends locally compiled plans to `POST /admin/plans/import` (Bearer `ADMIN_TOKEN`); the API re-runs the grounding validator, so push before the first production cycle to spare the model quota. `pnpm probe:local --seed-plans` does it against the local API.
- Every figure on `/methodology` and `/bot` comes from `PIPELINE`, `FREE_TIER` and `TARGET_GOAL` in `packages/core/src/pipeline-facts.ts`; `apps/web/src/lib/honesty.test.tsx` fails if one is hand-typed. Change a constant there, never in the page.
- `node scripts/scale-estimate.mjs` recomputes the shard, Actions-minute and storage estimates in `docs/NOTES.md`.

## Detection power (P9c)

- `qsr mutate` is local only. Nothing under `packages/cli/src/mutate/` may import the API client, the admin client or the report job, name an `/internal` or `/admin` path, or call `fetch`; `mutate/command.test.ts` pins it. A mutated run is never a result.
- A mutant is a (docs, plan) pair changed identically; the real grounding validator must accept it, otherwise it is `invalid`. Do not weaken the validator to get mutants through.
- `qsr-check-exports` (`ExecuteDeps.exportsCheck`) is an experiment behind a flag and is NOT enabled in any production cycle: do not set it from `qsr execute`, `qsr plan` or a workflow without an explicit decision, because it changes what level 2 means on the public pages.
- `docs/DETECTION-POWER.md` is generated by `qsr mutate --render` except its "Recommendation" section; format it with prettier after rendering.

## L3 needs evidence (harness v3)

- An L3 claim needs an auth pattern in the run step's output (`ALL_AUTH_PATTERNS` in `packages/core/src/output-patterns.ts`: the spec patterns, then registered vendor patterns). A vendor pattern is added ONLY from output a real run produced, with a fixture in `packages/core/fixtures/vendor-output/<vendor>.txt` (a test fails without one). Exit code 0 with no evidence passes the run but caps the level and records `runner_env.l3`.
- A target with no vendor API (a library) declares `expect.localOnly: true` and is level 2. The run page says "Snippet executed locally (no vendor involved)" for it; that line never affects a level, status or badge. Level is part of the plan cache key, so changing a target's level means re-registering its plan (`qsr plans push <slug>`) before the next cycle.

## Shadow-L3 and the request budget

- `l3: { mode: shadow, reason }` (Zod, reason required) in a target file runs the L3 step in shadow: recorded on the last step as `shadowL3` (`step_results.shadow_l3`), read only by `GET /admin/l3-shadow` and `qsr l3-shadow-report`, zero effect on level, status, incidents, badges and public pages (tests pin it, as for the export check). A shadow target has `level: 3` in its file so the compiler emits the run step; the API stores and shows level 2. **Never promote one without the owner's approval**: promotion is removing `l3:` from the file, and `qsr l3-shadow-report` only says whether the evidence is there (at least 8 cycles with a record, all with the same evidence, none without).
- At most one vendor request per L3 or shadow target per cycle: the probe does not retry a failure at a run step, and `qsr mutate` does not make vendor calls for these targets unless `--allow-vendor-calls` is given.
- A new vendor pattern is added to `VENDOR_AUTH_PATTERNS` ONLY from real output captured with a dummy key, with its fixture in `packages/core/fixtures/vendor-output/`.

## Harness versions and the shadow export check (P9d)

- `HARNESS_VERSION` (`packages/core/src/run-result.ts`) is the version of the executor checks, stored on every run and step result (`runs.harness_version`, `step_results.harness_version`; 1 is everything before versioning, 2 added the module and dotted-import fixes, 3 is the current: L3 needs evidence) and shown on the run page. **Bump it whenever a change to a check (`check-scripts.ts`) can change a verdict.** Do not bump it for a change that only touches wording or logging.
- The status engine never counts failures under different harness versions as consecutive (`comparableState` in `packages/status/src/evaluate.ts`, `ToolState.lastFailureHarnessVersion`). A version bump must never change a status by itself; the tests that pin it are in `evaluate.test.ts` and `apps/api/test/harness-version.test.ts`. After a bump, run `scripts/verify-version-bump.mjs` against the status taken before the deploy.
- The export check (`qsr-check-exports`) runs in SHADOW mode in `qsr execute` (`ExecuteDeps.shadowExportCheck`): last, after every normal step, recorded only as `shadowExportCheck` on the imports-check step and read only by `GET /admin/shadow` and `qsr shadow-report`. It must have no effect on a step outcome, level, classification, status, incident, badge or public view (`packages/executor/src/shadow.test.ts`, `apps/api/test/shadow-report.test.ts`, and the public view test pin it). Do NOT promote it into status without an explicit decision (P9b reads the shadow report first). `ExecuteDeps.exportsCheck` (the experiment that does affect a run) stays off in every production cycle.
- A target whose docs snippet is TypeScript without a signal the check can see opts out with `harness: { skipExportCheck: true, reason: <at least 10 characters> }`. The reason is required (Zod) and shown in the shadow report.
- `qsr mutate --controls-only` runs the unmutated plans once under the current harness (use it before enabling a new harness version: every PASS to FAIL flip is investigated, none is tuned away). `scripts/compare-controls.mjs` prints the v1-vs-v2 table. `docs/DETECTION-POWER.md` never carries a blended detection rate: install-level and code-level mutants are reported apart, by level, with their denominators.

## Launch kit (P10a)

- **Nothing in this repository sends, posts or contacts anyone.** `docs/templates/disclosure-email.md` is a template, `docs/WALKTHROUGH.md` a script, `scripts/launch-check.mjs` only reads. Disclosure outreach and posting (P10b) are a person's act and a separate instruction.
- **Only a vendor-class incident can be made public.** `confirmIncident` (`apps/api/src/services/admin-actions.ts`) refuses every class that is not in `VENDOR_FAILURE_CLASSES`; a transient or infrastructure incident can only be resolved or marked a false positive. `docs/DISCLOSURE.md` states the policy and `apps/api/test/admin.test.ts` pins it. Do not add a way around it.
- **Generated, not typed.** The README has two generated blocks (`<!-- qsr:status -->`, `<!-- qsr:detection -->`) and its prose may contain no figure (`packages/cli/src/readme.test.ts` fails on one). `pnpm qsr readme` (then `pnpm format`, which aligns the table; `--check` ignores that spacing) refreshes them from the site's `GET /api/status` and `docs/detection-power.json`; run it after the site is deployed, then commit. `/methodology` reads `apps/web/src/data/detection-power.json`, which `pnpm qsr detection-summary` writes from `docs/detection-power.json` and the target files (`--check` fails when stale; run it after every `qsr mutate --render` or when a target's `l3` mode changes). The wording about the badge and each level is built once in `packages/core/src/detection-wording.ts`, and a test compares it with the approved text in `docs/DETECTION-POWER.md` (Candidate B): update the hand-written Recommendation there when a figure changes.
- **No L3 rate and no blended rate**, on the site, in the README, in an image: the L3 line is "rests on N quickstarts" and the install and code kinds are never added. `GET /api/status` is a strict schema (counts and a time only).
- **Public pages never wait for the API.** `apps/web/src/lib/no-api-at-render.test.ts` lists the only files that may read the API address (submit, warm-up, admin and their helpers). Opening `/submit` sends `POST /api/warm`, which wakes the sleeping API after answering. A slug is checked against one cached list (`getKnownSlugs`) before any per-slug lookup, so a made-up slug costs no query.
- **The launch gate** is `node --env-file=.env scripts/launch-check.mjs` and `docs/LAUNCH-CHECKLIST.md`; a test keeps their ids equal. It needs `pnpm build`. A FAIL blocks the launch. The licence is the MIT License, copyright Aditya Kalambe (the owner's decision of 2026-10-18); the `license` check and `packages/cli/src/readme.test.ts` fail if the `LICENSE` file, the README's License section or the root `package.json` stop agreeing.
- **The promise to a vendor** (the owner's decisions of 2026-10-18 and 2026-10-19) is `PIPELINE.optOutHours`, `PIPELINE.vendorReplyBusinessDays` and `OPT_OUT` / `optOutSentences()` in `packages/core/src/pipeline-facts.ts`: probing stops within `optOutHours` of an opt-out request; the quickstart's page stays up, labelled "no longer monitored at the vendor's request"; past results stay visible and are hidden ONLY if the vendor asks for that; a written reply follows within `vendorReplyBusinessDays` business days. That supersedes the spec's "hide its history" within 24 hours. The three sentences come from `optOutSentences()` and nowhere else: the vendor form, `docs/DISCLOSURE.md`, `docs/ABOUT-OUR-TRAFFIC.md`, the email template, the README `promise` block, `docs/CLAIMS.md`, `/bot`, `/methodology` and `qsr opt-out` all use them, and `packages/cli/src/opt-out-wording.test.ts` plus the `bot-content` and `methodology-content` tests pin every one word for word. Change the sentences in core, then regenerate; never edit a surface by hand.
- **An opt-out is a database state, not a file edit.** `qsr opt-out <slug> [--hide-history]` (admin token) calls `POST /admin/tools/:slug/opt-out`: the tool is switched off with `disabled_reason = 'opt_out'` and `opted_out_at`, a target sync never switches it back on, and `public_tools` keeps it (with `opted_out_at`) while `public_run_history`, `public_runs` and `public_incidents` keep its past results. `qsr hide-history <slug>` (`POST /admin/tools/:slug/hide-history`, 409 unless the tool opted out) sets `history_hidden`, which removes its runs, history and incidents from every public view and blanks its `public_tools` result columns (migration 0009). An admin pause (`POST /admin/tools/:slug/disable`, `disabled_reason = 'admin'`) is NOT an opt-out and still removes the tool from every view. On the site an opted-out tool is out of the headline and the tables, listed apart under the label on the home page, and its badge says "no longer monitored"; `apps/web` hides a `history_hidden` tool's runs, incidents and run pages itself as well (the fixtures hold poisoned rows for `hidden-history-node`, `e2e/leak.spec.ts` must stay green).
- **`docs/CLAIMS.md` is the only source for a figure in a public post.** `pnpm qsr claims` (then `pnpm format`) writes it from the site's `/api/status`, `docs/detection-power.json`, the target files, `PIPELINE` and the admin API (`--no-admin` leaves the operations rows as "not generated"); `pnpm qsr claims --check` and the launch check's `claims-current` fail when it is stale. Each row has a safe and an unsafe wording; a row changes with a promoted shadow target when its "Changes when shadow targets are promoted" cell says so. Tests fail if a number in the README or on `/methodology` is not in the sheet, if a row is missing for a figure the site quotes, or if any row carries an install-level and code-level figure added together. Regenerate the README (`pnpm qsr readme`) and the sheet together.
- **The disclosure log** is `docs/disclosure-log.md`, kept by hand and empty on purpose; the launch check reads it (`disclosure-log`, `disclosures-48h`).
- **`GET /health` is shallow** (no database, no log line): Render restarts the service when it does not answer within five seconds. The database check is `GET /admin/ready`. The report job retries 429 as well as 502, 503 and 504 (`REPORT_RETRY_STATUSES`) and never turns a rate limit into a `HARNESS_ERROR`. The launch check never bursts above the limiter's advertised limit, one request at a time, and `--no-burst` skips it.
- **A validly signed `/internal/*` request is never rate limited** (the probe's report is about two requests per tool, a hundred from one address in seconds). An unsigned or badly signed one is a 401 and counts against the limiter (a 429 once the address has used its allowance); public routes, admin routes and every other path keep the limiter. The exemption is by registered route in the HMAC scope (`hmacRoutes` in `apps/api/src/app.ts`), not by path prefix. `apps/api/test/rate-limit-internal.test.ts` sends three times a report's volume.
