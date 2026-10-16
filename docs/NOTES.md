# Notes for later phases

Decisions and findings that are not in the spec and not obvious from the code. Newest first. The spec
(`QuickstartRot - Build Spec.pdf`) remains the source of truth; where this file adds to it, it says so.

## Carry-forward (requested, not implemented yet)

### P6: key the plan cache on a config hash, not on `--refresh`

`compiled_plans` is unique on `(tool_id, content_hash, compiler_version)` (spec section 5). A plan also
depends on the target file: its `placeholders`, `level` and `language` change what the model is told and
what the validator accepts, but changing them does not change the docs hash. Today the only remedy is
`qsr compile <slug> --refresh`.

- Add `config_hash` (hash of `placeholders + level + language`) to `compiled_plans`, to its unique key and
  to the cache lookup. The file cache in `packages/compiler/src/cache.ts` takes the same field.
- The `tools.config_hash` column already exists (the full YAML); the plan key needs the narrower hash so
  that editing `notes`, `owners` or `name` does not recompile.
- This is a change to the spec's unique key, so tell the owner when doing it.

### P6: store the truncation record and the P5 results

- `compiled_plans` needs a `truncation jsonb not null` column (the `CompiledPlan.truncation` object, see
  "Long pages" in the compiler README). Until it exists the API cannot store it, and a plan built from part
  of a page would look complete in the database.
- `/runs/[id]` should show "page truncated: N blocks not shown to the compiler", and a truncated plan must
  never be the evidence for a published BROKEN without a human looking at that. (The compiler already caps
  such a plan at L2 unless it has an install, a file write and a run step.)
- `runs.failure_class`, `failure_signature`, `failed_step_id` and `classifier_rule` already exist (P1):
  ingest fills them from `@qsr/classifier`. `llm.fallback` answers must be listed in the admin queue.
- The API builds `StatusContext` from the database: `openIncident`, `recentlyResolvedIncidents` (the engine
  applies the 7-day window itself, so passing more than 7 days is harmless) and `previousReachedLevel` (the
  `reached_level` of the tool's previous valid-cycle run). `cycleValid` is the cycle's `valid` flag.
- A `FALSE_POSITIVE` review resolves the incident and resets the streaks (spec section 10): that is an admin
  action in the API, not part of `evaluate`.

### P9: choose the 50 targets for an L3 path

Bias the target list toward funded devtool SDKs whose quickstart can be tested at L3 with a dummy key
(auth-error-as-pass). `chalk-node`, `loguru-python` and `python-dotenv` stay as **calibration targets
only**: they have no API to reach, so they prove the pipeline works, not that a vendor's endpoint is
wired up. Resend is the model case: its SDK prints the 401 and exits 0, so the log shows the client
reached the endpoint.

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
