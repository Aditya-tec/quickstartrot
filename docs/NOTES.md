# Notes for later phases

Decisions and findings that are not in the spec and not obvious from the code. Newest first. The spec
(`QuickstartRot - Build Spec.pdf`) remains the source of truth; where this file adds to it, it says so.

## Carry-forward (requested, not implemented yet)

### P9: choose the 50 targets for an L3 path

Bias the target list toward funded devtool SDKs whose quickstart can be tested at L3 with a dummy key
(auth-error-as-pass). `chalk-node`, `loguru-python` and `python-dotenv` stay as **calibration targets
only**: they have no API to reach, so they prove the pipeline works, not that a vendor's endpoint is
wired up. Resend is the model case: its SDK prints the 401 and exits 0, so the log shows the client
reached the endpoint.

## Findings from P7 (probe pipeline: plan / execute / report and the workflows)

### Pre-flight answers

- **Canaries are rows in `tools`, and they are never public.** `/internal/targets/sync` takes any valid target, so
  `targets/_canary/*` sync like the rest (the plan job sends real targets and canaries in one call). `tools.is_canary`
  (generated from `slug LIKE 'canary-%'`, migration 0003) is excluded by all three public views. New test
  (`apps/api/test/preflight.test.ts`): after a whole cycle, `SET LOCAL ROLE anon` and select from `public_tools`,
  `public_runs` and `public_incidents` returns no canary, even with a CONFIRMED incident planted on one; anon cannot read
  the base tables at all. No migration was needed for this.
- **Pre-execution failures had no clean path in P6** (the compile endpoint queued an admin item but no run existed, so the
  history showed nothing). Added the smallest one: an optional `preflight` object beside `runResult` on
  `POST /internal/runs` (`{stage, failureClass: CRAWL_ERROR | COMPILER_ERROR, reason, message}`). `RunResult` is unchanged.
  The API stores a run with outcome FAIL, that class, signature `<class>:<reason>`, rule `preflight`, no steps and level 0, and
  refuses a preflight run that has steps, a level, a failed step or an outcome other than FAIL. The engine already maps these
  classes to "unchanged state + admin queue item"; finish now de-duplicates that item against the one the compile endpoint
  queued, so one problem is one item. A `deferred` entry with no plan posts nothing (informational skip).

### Decisions and deviations the owner should know about

- **Migration 0005 (`public_pass_rate`, NOT yet applied to the live database).** `public_tools.pass_rate_30d` counted every
  FAIL as a verdict. A pre-flight FAIL, and a FAIL on a stale plan, are not verdicts, so they no longer count. Apply with
  `pnpm --filter @qsr/db db:migrate`. Nothing else depends on it; until then the pass rate is merely pessimistic.
- **A FAIL on a stale plan is not evidence against the vendor.** A stale plan is the tool's last accepted plan, used because
  the model was not asked (token budget), so a failure may only mean the docs moved on. `finish` hands the engine a
  COMPILER_ERROR for such a run (queue item "failed with a stale plan", no streak, no incident); the stored run keeps its
  true class. A PASS on a stale plan counts normally. Runs carry `runner_env.plan_stale = "true"`.
- **Each shard runs `canary-pass-node` (spec), which needs a rule.** Shard 0 runs it as itself; shards 1..N-1 run it as a
  _guard_ into `results/guards/shard-N/`. The report posts a guard only when it did NOT pass, as attempt `10 + shard` of
  `canary-pass-node`; the API's canary check looks at the final attempt, so a broken runner invalidates the cycle. A shard
  that produced no results at all does NOT invalidate it: its tools get HARNESS_ERROR runs (queue items only), the other
  shards' results stand. `UploadsBody.attempt` now allows up to 20 for this.
- **The report job also downloads the `plans` artifact** and `qsr report` takes `--plans` (spec shape downloads only results):
  it needs the manifest and the pre-failed entries to know what was planned.
- **`qsr execute` does not start the fixture server unless a plan refers to it.** No canary plan does (the fixture pages
  are only crawled, in the plan job, which does start the server). The code path exists and is tested.
- **Workflow inputs go through `env:`, never into the script text** (`--only "$ONLY"`), unlike the spec's inline sketch. A
  test forbids `github.event`, `inputs.` and branch names inside any `run:`.
- **`qsr validate`** (used by `validate-targets.yml`) also refuses a non-canary `docsUrl` that is not a public https URL (same
  validator as `/submissions`, moved to `@qsr/core`) and a placeholder value that looks like a real credential. A fork PR
  cannot aim the runner's crawler at `http://169.254.169.254/` or `localhost`.
- **P6 gaps fixed on the way:** `createSignedUpload` now sends `x-upsert` (a re-run report signs the same path again);
  `SAFE_STEP_ID` and the URL validator moved to core so the report job and the API share them.
- **`turbo.json` passes the test env** (`QSR_REQUIRE_DB` etc.) since P6; unchanged here.
- **Pinned actions** (full SHA + version comment, all workflows including ci and images): checkout 4.4.0, pnpm/action-setup 4.4.0,
  setup-node 4.4.0, cache 4.3.0, upload-artifact 4.6.2, download-artifact 4.3.0, codeql-action 3.39.0, gitleaks-action 2.3.9,
  setup-buildx 3.12.0, login-action 3.7.0, build-push 6.19.2. Each was resolved with `git ls-remote` and re-checked against
  the GitHub commits API. actionlint runs in CI from a digest-pinned image over `.github/workflows/*.yml`.

### What was verified, and what was not

Verified locally with `pnpm probe:local` (real Docker, real Chromium, real Groq, a local API and Postgres, a stand-in for
Supabase Storage speaking the same REST shape): plan -> 2 shards -> report with 4 canaries + 4 real tools gave a valid
cycle, 8 runs, 37 step results, 28 uploaded logs, no duplicates; the same cycle reported twice returned identical run ids;
a canary with a wrong expected outcome made the cycle invalid and moved no tool state; dropping shard 1's results turned its
tools into HARNESS_ERROR runs (queue items, statuses unchanged); a token budget of 1 produced a flagged stale plan that ran.

**Not verified:** the real GitHub Actions run; the log upload to real Supabase Storage (the multipart `PUT` to a signed URL, and
whether the gateway wants an `apikey` header: the report sends `SUPABASE_ANON_KEY` if the variable is set), because the live
project had no buckets yet; issue creation through `GITHUB_TOKEN` (tested against a fake `fetch` only). DEPLOY.md has
"First real probe run" with what to send if any of these fails.

### What P8 needs from this

- `runs` now holds rows that never executed: outcome `FAIL`, `failure_class` CRAWL_ERROR or COMPILER_ERROR, no steps, level 0,
  `classifier_rule = 'preflight'`. Show them as "not run" with the reason (the signature is `<class>:<reason>`), not as a
  vendor failure. `runner_env.plan_stale = "true"` marks a stale-plan run: show it.
- The report's run links are `<WEB_BASE_URL>/runs/<run id>`; the run page route should be `/runs/[id]`.
- `public_tools.pass_rate_30d` excludes both kinds above (after migration 0005).
- Step logs are gzip files in `public-artifacts` at `logs/<cycle>/<tool>-<attempt>-<token>/NN-<step>.log.gz`, listed in
  `public_runs.steps[].log_path`; the web must gunzip them (they are stored as `application/gzip`).
- The API (not the report job) calls the web revalidation hook at cycle finish, and only for a valid cycle (P6).

## Findings from P6 (API, DB-backed cache, cycle finish)

### What was carried over from P5, and where it landed

- **Plan cache key** is now `(tool_id, content_hash, config_hash, compiler_version)` (migration 0003; a change to the
  spec's unique key, flagged to the owner). `config_hash` = `compileConfigHash(target)` in `@qsr/core`: a hash of
  `placeholders`, `level`, `language` and `extract.variants`, so editing `notes`, `owners` or `name` does not recompile.
- **`compiled_plans.truncation jsonb not null`** stores what the model did not see. The compile response carries it.
- **`StatusContext`** is built in `apps/api/src/services/incidents.ts` (`incidentContext`): `cycleValid` from the cycle,
  `openIncident`, `recentlyResolvedIncidents` (the 7-day window is applied by the engine) and `previousReachedLevel`
  from the tool's previous valid-cycle run. `FALSE_POSITIVE` is an admin action (`admin-actions.ts`), not part of `evaluate`.
- **Classifier output** (class, rule id, signature, failed step id) is stored on `runs` at ingest. `llm.fallback`
  answers are queued for the admin.

### Block variants (crawler, not compiler)

`extract.variants: { splitOn: [regex…], prefer: regex }` splits a code block at marker lines and keeps the preferred
sub-block (plus any shared preamble and tail), dropping the marker line. The choice is recorded in
`Extraction.variants` and covered by `contentHash`, so the hash reflects what runs. A configured target whose
markers do not match is `CrawlError('variant_not_found')`: the page changed shape, and that must be visible.
`fastify-node` uses it with `prefer: ESM`. Result of `qsr run fastify-node`: **L2 PASS** (was L1 FAIL, `DOCS_SNIPPET_ERROR`), from a plan the model compiled
under `COMPILER_VERSION` 2026-10-16.5 (`npm i fastify`, `package.json`, `index.js`; syntax and import checks pass).
Earlier in the day the Groq quota was exhausted and a hand-built, grounding-validated plan was used to prove the
crawler change; the model plan replaced it once the quota reset. `resend-node` (L3 PASS) and `vitest-node` (L2 PASS)
were recompiled and re-run the same way.

### Token budget and the Groq quota

The Groq free tier allows 200,000 tokens a day; the API's own budget is `GROQ_DAILY_TOKEN_BUDGET` (default 150,000)
against the sum of `llm_calls` over the last 24 h. Over budget: no call, `deferred` with `reason: "llm_budget"` plus
the tool's most recent accepted plan (any compiler version) marked `stale: true`; with none, the tool is skipped this
cycle and an informational admin-queue item is added. A quota error, a 429/5xx after one Retry-After, or the 100 s
timeout is `deferred` too, **never** `COMPILER_ERROR` and never an input to a status. At most 2 model calls per
compile request. Token counts are estimated up front (`budget.ts`, 2.9 characters per token, 1,500 expected output
tokens), then the provider's real counts are logged to `llm_calls`.

### Cycle finish

`POST /internal/cycles/:id/finish` runs in one transaction: `FOR UPDATE` on the cycle, idempotent (the stored result is
returned when it is already finished), canary check against `CANARY_EXPECTATIONS` (a wrong or **missing** canary
makes the cycle `valid = false`: no transitions, one `cycle_ignored` note), then per tool the final attempt, tool row
`FOR UPDATE`, `evaluate`, persist, apply events. After commit and best effort: incident enrichment (docs diff into
`public-artifacts`, version diff from `runner_env.resolved`, LLM summary under the budget) then the web revalidation
hook. Neither can fail the request; an enrichment failure creates an admin-queue item.
`targets/_canary/canaries.json` and `CANARY_EXPECTATIONS` are pinned together by a CLI test.

### Migrations

`0003_api_p6` (applied to the live Supabase 2026-10-16): `compiled_plans.config_hash` (not null, in the unique key),
`compiled_plans.truncation`, `probe_cycles.gh_run_attempt` and `finish_result`, `tools.is_canary` (generated from
`slug LIKE 'canary-%'`), `incidents.version_diff`, table `admin_queue_items` (RLS on, no anon access); indexes
`llm_calls(created_at)`, `submissions(ip_hash, created_at)`, unique `probe_cycles(gh_run_id, gh_run_attempt)`
(partial, idempotent cycles), `admin_queue_items(state, created_at)` and unique `(run_id, reason)` (partial); the three
public views are recreated without canaries. `0004_status_engine_inputs` (applied live 2026-10-16): `runs.reached_level`,
`runs.skip_reason`, `tools.disabled_reason` (`file_removed`, which a re-sync may undo, vs `admin`, which it may not).
Why 0004 is separate: it was found while building `StatusRun`; 0003 was already applied and applied migrations are never edited.
After both, the live RLS tests pass 32/32.

### What P7 needs from this API

The probe workflow signs every `/internal/*` call with `INGEST_HMAC_SECRET` (use `createApiClient` from `@qsr/cli`;
it re-signs on each retry). Call `wakeApi()` first. Order of one cycle:

1. `POST /internal/targets/sync` with the parsed targets (idempotent; a removed file disables the tool with `disabled_reason = file_removed`).
2. `POST /internal/cycles` `{trigger, gitSha, ghRunId, ghRunAttempt}` → `{cycleId, created, tools[]}`. Idempotent on `(ghRunId, ghRunAttempt)`, so a re-run of the plan job is safe. `tools[]` includes the four canaries (`isCanary`): they MUST be run every cycle, otherwise the cycle is invalid.
3. Per tool, crawl, then `POST /internal/compile` `{cycleId, toolSlug, extraction | crawlError}`. Handle all four answers: `ok`, `compiler_error`, `crawl_error`, `deferred`. On `deferred`, run the `stale` plan if there is one (the result is still a real run) and skip the tool otherwise; do not report a failure.
4. Execute in the sandbox (no secrets, no API calls). Then, from the reporting job, per attempt: `POST /internal/uploads` `{cycleId, toolSlug, attempt, files:[{stepId, ordinal}]}` → signed URLs; PUT the gzipped redacted logs; then `POST /internal/runs` `{runResult, logPaths: {stepId: path}}`. Idempotent on `(cycleId, toolSlug, attempt)`; paths are re-validated as belonging to the run. Body limit 5 MB.
5. `POST /internal/cycles/:id/finish`, then read `FinishResponse`. Always call it, even when a tool was skipped; a tool with no run in the cycle is left unchanged.
6. `POST /admin/gc` nightly (HMAC, same as `/internal`).

Cold start: 30-60 s on the free tier; `wakeApi()` waits up to 3 minutes. P8: the revalidation call sends header
`x-revalidate-secret: <REVALIDATE_SECRET>` to `REVALIDATE_URL` with the JSON body `{"source":"api","cycleId":"…"}`; the web route must check it.

### Decisions the owner should know about

- `/submissions` stores only an HMAC of the IP (keyed by `SUBMISSION_IP_SECRET`), 5 per day per hash. The URL is never fetched automatically.
- Admin auth: 5 failed attempts per 15 minutes per client blocks that client, and a blocked client is refused without the token being compared.
- `render.yaml` sets `NODE_VERSION` and `NODE_ENV` as plain values (they are constants, not secrets); every other variable is `sync: false`.
- The smoke script's signed POST creates one harmless cycle (`git_sha = smoke-test`, `gh_run_id = 1`), reused on every run.
- A bug found by the new Storage test: `Storage.list` returned names relative to the prefix, so `/admin/gc` would have removed the wrong paths. Fixed before it shipped.
- `turbo.json` now declares `QSR_REQUIRE_DOCKER`, `QSR_SKIP_DOCKER_TESTS`, `QSR_REQUIRE_DB` and `QSR_TEST_DATABASE_URL` for the `test` task. Turbo's strict env mode had been stripping them: the API database tests would have **skipped silently in CI**, and `QSR_REQUIRE_DOCKER` from P4 was likely never reaching the executor tests either (they ran only because Docker is present). They are in the cache key, so a cached "skipped" result is never replayed.

## Findings from P5 (classifier, status engine, and the four fixes made first)

### L2 now means "the snippet parses and its imports resolve" (supersedes the P4 note)

P4 reported level 2 as "files were written", which overclaimed: a file that does not parse or imports a
package nobody installed still got L2. The executor now runs two harness-owned `harness_check` steps
(`qsr-check-syntax`, `qsr-check-imports`) after the last file write and install. They are not part of the
plan and cannot come from the LLM or the docs. Full description, the limits (dynamic imports are not
checked) and the TypeScript decision are in `packages/executor/README.md`.

What the real-image tests found while building it (all fixed, all covered):

- The image's global `typescript` is **v7**, the native port: no JS API, so `transpileModule` does not
  exist. The check runs its `tsc` binary with `--noEmit --noResolve` and keeps only the syntactic diagnostics
  (TS1xxx). `tsc --noEmit` alone fails correct snippets (no tsconfig, no `@types`), and `tsx` has no check mode.
- `import.meta.resolve('pkg/dist/gone.js')` returns a URL **without checking the file exists** when the
  package has no `exports` map, so a deep import of a vanished file passed the check and only failed in the
  `run` step. The script now verifies the file; an ES-module importer uses the ESM resolver only.
- Levels: L1 = every install step exited 0; L2 = L1 + checks passed; L3 = L1 + no failed check + the `run`
  step met its Expect. A plan that writes no checkable source file claims no L2. A failed check is a `FAIL`
  at level 1; a check that crashes (any exit but 0 or 1) is a `HARNESS_ERROR`, never a verdict on the docs.
- `StepResult.ordinal` is now the position in the result's step list (checks are inserted), not the plan index.

### A manual stop is `SKIPPED`, not `FAIL` (supersedes the P4 note)

The run outcome is `SKIPPED`; `reachedLevel` is kept (the level before the stop) and `failedStepId` is the
manual step. The reason is carried as `skipReason: 'manual_step'` on the **step result**, not on `RunResult`:
spec section 9 defines `RunResult` exactly, and `core` has a test that pins its keys. `runSkipReason(run)`
reads it. A manual step after the target level was already proven is still a `PASS`. `qsr run` exits 5 for
SKIPPED. The classifier maps a SKIPPED manual stop to `NEEDS_CREDENTIALS` (`skipped.manual_step`) and the
status engine never lets it change a status or open an incident (an admin queue item, or `plan_regressed` if
the tool used to reach a higher level).

### New levels of the 10 real targets (2026-10-16, `qsr run`, local images)

| Target        | Before (P4) | Now            | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chalk-node    | L3          | L3 PASS        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| dotenv-python | L3          | L3 PASS        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| loguru-python | L3          | L3 PASS        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| resend-node   | L3          | L3 PASS        | executed from the cached `.4` plan (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| drizzle-node  | L2          | L2 PASS        | now real: syntax and imports checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| pytest-python | L2          | L2 PASS        | now real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| zod-node      | L2          | L2 PASS        | now real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| vitest-node   | L2          | L2 PASS        | executed from the cached `.4` plan (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| fastify-node  | L2          | **L1 FAIL**    | the first server block holds the ESM and the CommonJS variant together (`import Fastify …` then `const fastify = require(…)`), so run literally it is a `SyntaxError: Identifier 'fastify' has already been declared`. The P4 "L2" was an overclaim; the check is right that the snippet does not run as written. It classifies as `DOCS_SNIPPET_ERROR`. Before this target is published, decide how a page that shows two alternatives in one block is handled (target `extract` options, or a compiler rule that cites one variant), or it will read as a vendor break. |
| hono-node     | L0 FAIL     | L0 **SKIPPED** | manual step (interactive scaffolder); `qsr run` exits 5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

resend-node and vitest-node could not be recompiled: the Groq free tier's **daily token budget (200,000 per day)** was used up by this day's work, and `COMPILER_VERSION` changed so the old cached plans no longer match. Their pages are not truncated, so only the system prompt differs; their executor results above come from running the previously cached plans directly. Recompile them (`qsr compile <slug>`) once the quota resets.

### Truncation is selected, recorded, told to the model and capped

The P4 note "the compiler truncates the docs page and nothing records it" is resolved: see "Long pages" in the
compiler README. Verified on the three affected targets with `COMPILER_VERSION` 2026-10-16.5:

| Target        | Omitted blocks | Code blocks omitted                                                                                                                                       | Did an omitted block hold a step a new developer needs?                                                                                                                                                                                                                            |
| ------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fastify-node  | 34 of 65       | plugin file for the MongoDB example, a folder tree, 3 schema examples, "Run your server from CLI" (`package.json` start script, `server.js`, `npm start`) | The page's only run command (`npm start`, via fastify-cli) is omitted. The target is L2, so no run step is wanted, and the L2 cap keeps the plan from claiming more. If fastify is ever raised to L3 the heading "Run your server from CLI" needs to match the quickstart pattern. |
| loguru-python | 41 of 76       | 10 later feature demos (lazy evaluation, custom levels, notifier, ...)                                                                                    | No. Install, `from loguru import logger` and the first examples are shown.                                                                                                                                                                                                         |
| pytest-python | 7 of 38        | none (7 headings, whose text is in every block's `heading` field)                                                                                         | No.                                                                                                                                                                                                                                                                                |

A first version of the ranking was wrong for Fastify: its page title ("Getting Started") matched the quickstart
pattern for every block, so all code outranked all prose and the intro prose of the first server ("include
`"type": "module"`") was dropped while later plugin examples stayed. Matching now ignores the heading prefix
every block shares and ranks by unit (code plus its 2 introducing prose blocks) in document order. A test
reproduces the case.

### Classifier decisions

- The rule table is `packages/classifier/src/rules.ts` (the spec says `packages/classifier/rules.ts`; every
  package here keeps its code under `src/`). Order matters and is documented rule by rule in its README.
- 49 fixtures are **captured** from real runs in the sandbox images, 8 are `synthetic-*`. Real logs changed
  the design twice: pip ignores an `http://` index ("not a trusted or secure host") and, with `--retries 0`,
  prints nothing about a refused connection, so a network failure and a missing package can look identical;
  `--retries 1` makes pip print the retry warning that the `network.*` rules key on. Rules for network text
  therefore come before pip's "No matching distribution found".
- EBADENGINE is usually an npm **warning** on a successful install; `runtime.npm_ebadengine` matches only the
  error-level line (`npm error code EBADENGINE`, seen with `--engine-strict`).
- A top-level missing module is `DOCS_SNIPPET_ERROR` (the docs forgot an install); a missing file or dotted
  submodule inside an **installed** package is `API_DRIFT`. Same split for the harness checks.
- Auth: `AUTH_PATTERNS`/`DRIFT_PATTERNS` moved from the executor to `@qsr/core` so the executor and the
  classifier share one definition. `credentials.auth_error` is last and `run`-steps only, and never applies when
  `authErrorIsPass` is true: with it set, an auth error is the expected outcome and cannot be why a step failed.
- `StatusRun` for a CRAWL_ERROR or COMPILER_ERROR (no RunResult exists) is an outcome `FAIL` with that class.
- The LLM fallback sees the last 60 lines of the step's log (stdout and stderr interleaved), not only stderr:
  the executor's log is interleaved. It never runs for a SKIPPED or HARNESS_ERROR run.
- `qsr classify` uses rules only unless `--llm` is passed (then it needs `GROQ_API_KEY`).

### Status engine decisions

Documented next to the table in `packages/status/README.md`. The two that need the owner's eye: PASS from
DEGRADED goes straight to HEALTHY (the spec's "2 passes" applies from BROKEN), and `StatusContext` carries
`previousReachedLevel` and `incident.id` fields beyond the ones first listed, because `plan_regressed` and
"reopen that incident" cannot be decided without them.

### Migration 0002

`0002_tool_state_columns` adds `tools.transient_streak` (integer, not null, default 0),
`tools.last_failure_signature` (text) and `tools.last_failure_class` (failure_class) for `ToolState`.
Additive only. **Applied to the live Supabase** on 2026-10-16 (3 migrations recorded; the RLS integration
tests still pass 30/30). The public views are unchanged.

### Secret gate

`pnpm secrets:check` (gitleaks on the staged changes, local binary or the pinned Docker image) runs from a
husky pre-commit hook and fails closed. It exists because a P4 commit was made after a scan printed hits
without blocking. `pnpm test:scripts` proves it blocks, including a real `git commit` being refused; CI runs
those tests with Docker required.

## Findings from P4 (executor, images, canaries)

- **`docker cp` is not used for files.** The spec says to `docker cp` write_file content into the
  container. Verified on Docker 29: `docker cp` creates the file as `0:0` (root), and the unprivileged
  runner (uid 1001, all capabilities dropped) then gets `Permission denied` appending to it or
  rewriting it, so `append_file` and any tool that later edits a copied `package.json` would break.
  Files are written with `docker exec -i ... cat >` as the runner, after `realpath -m` resolves symlinks
  inside the container and refuses anything outside `/work` (exit 97, reported as `HARNESS_ERROR`).
- **`RunResult` is exactly spec section 9.** The extra `resolved` field added in P1 was removed;
  version-drift data lives in `runnerEnv.resolved` as a JSON string (`RUNNER_ENV_KEYS`, `parseResolved`).
- **npm 10 prints `npm error`, not `npm ERR!`.** The classifier rules match both. The 404 canary prints
  `npm error code E404` and `npm error 404 Not Found - GET https://registry.npmjs.org/<name>`.
- **Signature normalization strips npm's log file name** (`~/.npm/_logs/2026-10-16T07_51_26_705Z-debug-0.log`),
  which contains a timestamp, or two identical failures would get different signatures.
- **Canaries use committed golden plans** (`targets/_canary/<slug>.plan.json`), validated against the live
  fixture page with the grounding validator before each run. They test the executor, not the model.
  Expected answers are in `targets/_canary/canaries.json`; P6's cycle-finish check should read them.
- **Image digests.** `runnerEnv.imageDigest` is the registry (manifest) digest for an image pulled from
  GHCR and the image ID for one built locally (`imageSource: local`). Docker Desktop's image store
  invents a repo digest for local builds, so "registry or local" is decided by the image reference, not by
  the presence of a digest.
- **Docker Hub:** the base images are pinned by digest in the Dockerfiles. `images.yml` mirrors them to
  `ghcr.io/<owner>/mirror/*` and builds `FROM` the mirror at the same digest, so CI never depends on
  anonymous Docker Hub pulls for the sandbox build. (`pnpm test` in CI still builds the images locally and
  pulls the pinned bases from Docker Hub once.)
- **The fixture server needs a free port 4177 for canaries**; `qsr run canary-*` reports a busy port
  instead of crashing.
