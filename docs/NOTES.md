# Notes for later phases

Decisions and findings that are not in the spec and not obvious from the code. Newest first. The spec
(`QuickstartRot - Build Spec.pdf`) remains the source of truth; where this file adds to it, it says so.

## Carry-forward (requested, not implemented yet)

Nothing is carried forward from P8 that P9a left open. The P9 request to choose the 50 targets for an L3 path was done in P9a (see
below): `chalk-node`, `loguru-python` and `dotenv-python` are calibration targets only, and the L3 share is small on purpose
(most vendor quickstarts need an account).

## Findings from the P9d follow-up (L3 evidence, shadow-L3, six L3 candidates, request budget, traffic note, retention)

Done on 2026-10-18, one commit per item (`8d4e3cd`, `fe70881`, `4bdaad0`, `619683c`, `4a8ee0f`, `bd40bad`, `140be34` and the last one), CI green on each. P9b and P10 are not started.

### 1. Harness version 3: an L3 claim needs evidence that a vendor was reached

A run step that merely exits 0 proves the snippet ran, not that a vendor was reached (`resend-node`'s L3 passed on exit code 0 because its snippet catches the
error; the 401 was in the output but nothing required it). L3 now needs an auth pattern in the run step's output: a spec pattern (`AUTH_PATTERNS`) or a
registered vendor pattern (`VENDOR_AUTH_PATTERNS`, each with a fixture of real output in `packages/core/fixtures/vendor-output/`; Resend's `API key is invalid` is
the first). The evidence is recorded whatever the exit code and a drift error beside it takes it away. A run step that passes without evidence passes the run
but is capped at L2, with `runner_env.l3` saying `no_evidence` or `local`.

**Audit of the five targets that were L3** (stored production output, last 10 to 12 runs each): `anthropic-node` evidence in 10 of 10 (`http_401_403`);
`resend-node` evidence in 12 of 12 (`http_401_403`, exit 0); `chalk-node`, `dotenv-python` and `loguru-python` no evidence in 12 of 12 (libraries with no
vendor), so they dropped to L2. The owner chose to apply the rule literally: those three declare `expect.localOnly: true`, are level 2, and their run page
says "Snippet executed locally (no vendor involved)". A level drop alone changes no status, opens no incident and queues nothing (`apps/api/test/level-drop.test.ts`).

**Gotchas.** (a) The level is part of the plan cache key, so a level change means re-registering the plan; the API refuses a plan import until the targets were
synced, and it recomputes the harness-owned fields (`maxLevelReachable` is `min(plan, target level)`), so the cached plan had to be re-finalized first (the
steps are untouched). (b) The LOCAL plan cache key has no config hash: a plan cached under another level or other placeholders is returned as it is, a REJECTED
plan is cached too, and `qsr compile --refresh` (or deleting the cached file) is needed after changing a target. (c) A placeholder must be the exact docs text
(`your-api-key-here`, not `your-api-key`), else `env.not_grounded`.

**First production cycle under version 3** (cron 11:20 UTC, cycle `9f041aab`): valid, all runs version 3, `scripts/verify-version-bump.mjs`: no target changed
status, no incident; `anthropic-node`, `anthropic-python` and `resend-node` PASS at L3 with evidence; the three local targets PASS at L2 with `l3: local`.

### 2. Shadow-L3

`l3: { mode: shadow, reason }` in a target file (Zod, reason required). The plan is compiled at the target's level (so it has the run step) but the API stores and
shows level 2. The executor holds the run step back and runs it ONCE, last, only when the run passed; what it said (verdict, pattern, exit code, observed line,
redacted and clipped) is recorded on the last step as `shadowL3` (`step_results.shadow_l3`, migration 0008) and read only by `GET /admin/l3-shadow` and
`qsr l3-shadow-report --days N`. It changes no level, status, incident, badge or public page (executor and API tests, as for the export check). The observed text is
the first error line and the first evidence line captured while the output streams, so a long stack trace cannot push them out of the 4 KB tail. Promotion is
removing `l3:` from the file, a decision for the owner: the report says "ready" at 8 cycles with a record, all with the same evidence and none without. It does
not promote anything. First cycle: `openrouter-node`, `cerebras-python`, `resend-python` recorded evidence once each.

### 3. The L3 targets

Approved: `anthropic-python` (counts at L3), and in shadow `openrouter-node`, `cerebras-python`, `resend-python`. Each snippet was compiled at level 3 from its docs and
run once locally in Docker with a dummy key; the real answers are fixtures (`packages/executor/fixtures/l3-observed`): Anthropic 401 `authentication_error`
("invalid x-api-key"), OpenRouter 401 (`UnauthorizedResponseError`, "Missing Authentication header"), Cerebras 401 ("Wrong API Key"), Resend prints only `API key is
invalid` and exits 0.

**Stopped, as instructed:** `slack-node`: the docs show no step that sets a token, so the request goes out unauthenticated and Slack answers `not_authed`, not
`invalid_auth`; evidence that Slack was reached, but not an auth pattern, and the token path is untested. Options: register `not_authed` from that output, or map
the docs' `process.env.SLACK_TOKEN` to a dummy with a placeholder to observe `invalid_auth`. Its target file is unchanged. `svix-node` is not a tracked target (excluded in
P9a: its page shows alternative snippets that the plan appends into one file, and the syntax check fails); it was listed by mistake.

### 4. Request budget and the public note

At most one vendor request per L3 or shadow target per cycle: the probe never retries a failure at a run step; `qsr mutate` makes no vendor request unless
`--allow-vendor-calls` (their controls are recorded as not run and their mutants as "not run", a new status counted apart; the Docker runner also refuses such a
plan). `/bot` has an "About our traffic" section (docs/ABOUT-OUR-TRAFFIC.md has the same text): which services, how often, from where, that nothing is created or
sent, how to ask us to stop, and that the terms were read on 18 October 2026 as a summary, not legal advice. The figures come from `TRAFFIC` in
`pipeline-facts.ts`; the list of services is pinned to the target files by a test. Terms: Mailgun (its terms bar testing authentication measures without written
consent) and Loops (its acceptable-use text bans any automatic device) were left out; Upstash and Turso could not be read; E2B and Slack were borderline.

### 5. loops-node's empty output (probe #13)

Its install step failed with exit 1 after 596 ms and stored empty tails; the stored log in Storage is empty too, so the step really wrote nothing and the original
failure is NOT recoverable (the capture waits for the process's `close` event, so no output was lost). A failed step that wrote nothing now says so in its stderr tail
and log (exit code; a program writing straight to the terminal is not captured). The classifier has nothing to write a rule from: the only text ever seen was
"Failed to download checksums from https://github.com/..." on my machine.

### 6. DB retention

`POST /admin/retention` (HMAC) and `qsr retention [--apply]`: the stdout/stderr tails of PASSING steps older than 30 days are set to null (no row is deleted; a
failing step's tails and everything an incident links stay). A dry run unless `dryRun: false` / `--apply`; the nightly `POST /admin/gc` does it for real and
reports `nulledTails`. Nothing is older than 30 days yet.

### 7. The disabled targets, re-checked under harness version 3

13 of the 18 disabled targets were run again with `qsr run` in real Docker (cached plans, no model calls); the result was the same as on 2026-10-17 for every one,
so none is re-enabled: `arrow-python` and `huggingface-hub-python` (the first snippet is a REPL transcript, syntax check fails), `chroma-python` (install killed at
180 s), `firebase-admin-node`, `ngrok-node`, `prettier-node` and `voyageai-python` (a manual step), `kysely-node` (HARNESS_ERROR: tsc refuses files on the command
line when a tsconfig.json is present, a harness limit worth fixing), `prisma-node` and `vercel-ai-node` (bun and pnpm are not in the image), `twilio-node`,
`twilio-python` and `upstash-ratelimit-node` (the plan input is alternatives or a fragment). Not run: `replicate-python`, `sendgrid-node` and `together-node` (L3 vendor
targets: running them would send a request to vendors not approved) and the drafts `groq-node` and `replicate-node` (never run).

### 8. Detection power

`docs/DETECTION-POWER.md` and the JSON: targets that declare no vendor are a fourth category, "executed locally (no vendor)", beside L1, L2 and L3 (their results are
kept: 6 of 6 install-level and 8 of 8 code-level detected, 3 targets); L3 rests on 2 targets (`anthropic-node`, `resend-node`) until the shadow targets are promoted and
no L3 percentage is quoted anywhere; the three targets whose level changed were run again under version 3, and the four targets that now have a vendor-facing step are
recorded as not run. The older "L3 rests on 5 targets" below is superseded.

## Findings from P9d (harness fixes, harness versioning, the export check in shadow mode)

Nothing was posted to the API by the mutation tooling, no vendor page was crawled again, no model was asked, no vendor was contacted. P9b and P10 are not
started. Production data was not touched except through the schema migration below; statuses only change through the normal cron.

### Harness version

- `HARNESS_VERSION` (`packages/core/src/run-result.ts`) is **2**. Everything recorded before is version **1** (the column default backfills it).
  `RunResult.harnessVersion` (default 1 when parsing an older payload) is the one new top-level key on the report payload (the spec section 9 shape test
  now lists it; the owner asked for it). `StepResult.harnessVersion` is stored on every step row.
- **Migration `0007_harness_version_and_shadow`** (additive, not applied to production until this commit is pushed; apply it BEFORE the deploy with
  `pnpm --filter @qsr/db db:migrate`): `tools.last_failure_harness_version smallint` (null), `runs.harness_version smallint not null default 1`,
  `step_results.harness_version smallint not null default 1`, `step_results.shadow_export_check jsonb` (null), and `public_runs` re-created with
  `harness_version` as its last column (the old definition otherwise unchanged, then `NOTIFY pgrst, 'reload schema'`). The `NOT NULL DEFAULT` columns are
  metadata-only changes in Postgres 11+, so existing rows read as 1 without a rewrite. Rollback: the API of the previous release ignores the new columns,
  so an old API against the migrated database keeps working.
- **Status engine rule:** failures under different harness versions are never consecutive. `evaluate` forgets the failure streak when the version of the new
  failure differs from `lastFailureHarnessVersion` (null on a tool that has failure memory counts as 1). A PASS clears the field. Tests: `evaluate.test.ts`
  (version-change cases for DEGRADED, BROKEN, transient streaks, the 100% coverage gate still holds) and `apps/api/test/harness-version.test.ts` (through the
  real finish path and Postgres: a v1 failure then a v2 failure leaves a tool DEGRADED and opens no incident; a bump alone changes no status).
- Shown on the run page as one small line ("Harness v2 ...") and in `qsr calibration-report` (versions in the window) and `/admin/stats` (`harness.versions`).
- Policy: bump the version whenever a change to a check can change a verdict.

### The two harness fixes (version 2)

1. **ES-module `.js` is parsed as a module.** `node --check` on a `.js` file that uses `import` where no `package.json` says `"type": "module"` exits 0 without
   parsing (v1 bug, found by P9c on the `mocha-node` and `vitest-node` syntax mutants). v2 detects module syntax and checks a `.mjs` copy. Test: a broken
   ES-module `.js` now FAILS, reproduced against both targets' shapes in real Docker (`checks.integration.test.ts`, "harness v2").
2. **Python dotted imports resolve the full path.** `import pkg.missing` (and `from pkg.missing import x`) fails the imports check with
   `ModuleNotFoundError: No module named 'pkg.missing'`. New classifier rule `check.python_submodule_missing` maps it to **API_DRIFT**, exactly like a Node
   deep import that names a file the package does not have (fixture `synthetic-python-check-submodule-missing.json`). A package that registers or lazily loads submodules at run time (a module-level `__getattr__`, `sys.modules`) is not flagged, because a missing file proves nothing there, and a local package the plan wrote itself is resolved from `/work`.

### Shadow export check

- `qsr execute` turns on `ExecuteDeps.shadowExportCheck`. The check runs after every normal step; its answer is stored only as
  `step_results.shadow_export_check` of the imports-check step and read only by `GET /admin/shadow` and `qsr shadow-report --days N`. Tests that pin the
  isolation: `packages/executor/src/shadow.test.ts` (outcome, level, failed step, step ids, outcomes, kinds and exit codes identical with and without the
  shadow, including when the shadow fails, crashes or times out), `packages/executor/src/execute.test.ts`, `apps/api/test/harness-version.test.ts` ("is in no
  public view") and `apps/api/test/shadow-report.test.ts`.
- **launchdarkly-node false positive**, fixed properly where a signal exists: a snippet is treated as TypeScript when its fence is `ts`/`tsx` or it uses
  TypeScript-only syntax, and the check then skips type-only imports. The `launchdarkly-node` snippet has **neither** signal (an untagged fence with imports
  only: `import { init, LDContext, LDOptions }`), so no deterministic rule can tell it from JavaScript. Making the compiler write such a snippet as `.ts`
  would change compiled plans, which means bumping `COMPILER_VERSION` and invalidating all 51 production plans (and spending the model quota), which is
  outside "do not touch production data". So that target uses the per-target opt-out `harness: { skipExportCheck: true, reason }` (required reason,
  Zod-validated, shown in the shadow report). Follow-up if wanted: teach the compiler a `.ts` path and migrate plans in one planned push.
- **vitest-node previous-major UNKNOWN (P9c experiment):** the raw output of the failing install was `npm error Cannot read properties of null (reading
'edgesOut')`, npm's own dependency-tree builder crashing when asked for `vitest@4`. That is an install that could not be resolved, so the narrowest honest
  class is DEPENDENCY_RESOLUTION: rule `dependency.npm_resolver_crash` matches only that exact message (fixture `synthetic-node-npm-resolver-crash.json`, the
  log lines are the real output). It was seen once; it is npm failing rather than a named package, so like every vendor-class failure it waits for review.

### Controls under harness v2 (all 51 unmutated plans, real Docker, concurrency 2)

`qsr mutate --all --controls-only` (new) then `node scripts/compare-controls.mjs .qsr-mutate/full.json .qsr-mutate/controls-v2.json`. **50 of 51 PASS under both
versions, at the same level in every case (L1 6, L2 39, L3 5), one retry in each run (the same one); `hono-node` is SKIPPED in both, by design. PASS to FAIL
flips: 0.** There was nothing to investigate, and no check was tuned. (Mean control time 9.7 s under v1, 9.2 s under v2.)

### Mutation suite, v1 against v2 against v2 with the export check (same seed `p9c`, same mutants)

Reported apart, never blended (`docs/DETECTION-POWER.md`, `docs/detection-power.json`):

| Mutants                     | v1                                                              | v2              | v2 + export check (experiment) |
| --------------------------- | --------------------------------------------------------------- | --------------- | ------------------------------ |
| Install-level (typo, pin)   | 98 of 98 (12/12, 76/76, 10/10 at L1/L2/L3, over 6/38/5 targets) | same            | same                           |
| Code-level, L2 (39 targets) | 61 of 137 (45%)                                                 | 71 of 137 (52%) | 90 of 137 (66%)                |
| Code-level, L3 (5 targets)  | 15 of 17 (88%)                                                  | 15 of 17 (88%)  | 15 of 17 (88%)                 |

L3 rested on 5 targets then (now 2, see the follow-up above); 97 mutants had no site (95 code-level, 2 install-level) and are in no rate; L1 has no code-level mutant at all (30 had no site). v2 newly
detects 10 (8 Python `deep_import`, the `mocha-node` and `vitest-node` syntax mutants) and misses none that v1 detected. The export check adds 19 more, all
classified as expected, with 0 false positives on the 50 controls (`launchdarkly-node` is opted out).

Findings of the measurement itself (each fixed with a test, then the suite was re-run):

- **A network failure was counted as a detection.** In the first v2 run a DNS blip made four mutants (`vitest-node`, `zod-node`) fail at the install step as
  `NETWORK_TRANSIENT` and the tool called them detected; one more (`loops-node renamed_method`) failed on a GitHub download. `runMutantJob` now runs a mutant a
  second time when its first failure is the environment's or of a class the operator does not expect; a second network failure is a `harness_error`, left
  out of the rates. v1's results had none of these. Five anthropic/cerebras mutants hit it twice, so those two targets were run again alone with the same seed
  and merged with `scripts/merge-mutate-reruns.mjs`; the document lists them under "Mutants run again after an environment failure".
- **The export check treated `key: name(...)` as a type annotation** (`drizzle-node` `renamed_symbol` survived): a call is a value. Fixed in `usedAsValue`.
- **The opt-out did not apply to the enforcing experiment** (`launchdarkly-node` failed its control with the check on): it does now, in both modes.

### What to do after the deploy (first production cycle)

Expected: **harness v2, statuses unchanged.** The first cycle after the deploy runs every target under v2 (and each target's shadow export check). Because the
controls above all pass under v2, and a failure under a different version never counts as the second of two, no target can change status because of the bump
alone. Verify afterwards: `node --env-file=.env scripts/verify-version-bump.mjs .qsr-runs/status-before-v2.json` compares each target's status with the one
taken before the deploy and prints the harness versions seen; every difference must be explained from its run. `qsr shadow-report --days 1` shows the first
shadow answers; `qsr calibration-report` shows the version table. The plans are NOT recompiled (`COMPILER_VERSION` is unchanged), so no model quota is spent.

## Findings from P9c (detection power: mutation testing of the monitor)

Local only. Nothing was posted, no vendor page was crawled again, no model was asked. P9b and P10 are not started. The public document is
`docs/DETECTION-POWER.md` and the raw results `docs/detection-power.json` (both generated by `qsr mutate --render`; the "Recommendation" part of the
document is hand-written and survives a re-render). After rendering, run `pnpm exec prettier --write docs` (CI checks the formatting).

### The tool

- `qsr mutate <slug>|--all [--sample N] [--seed S] [--operators ...] [--concurrency 2]` in `packages/cli/src/mutate/`: seeded operators, a pure engine
  that takes an injected runner (Docker in the command, a fake in tests), statistics, the report. `--plan-only` counts mutants and estimates runtime;
  `--baseline <json> --exports-check` re-runs controls and the survivors with the experimental check; `--render <json> [--compare <json>]` writes the docs.
- **Inputs are the local file cache**: the plan (`<hash>.<compiler>.json`) and, new in P9c, the crawled page (`<hash>.extraction.json`), which
  `qsr plans push` now saves next to the plan (also on a dry run). Because production had already been pushed, the 51 extractions of the earlier
  all-target crawl (`scripts/crawl-drift.mjs` output) were copied in with `scripts/backfill-extraction-cache.mjs`, which reads files only; their hashes
  (recomputed with each target's `hashIgnore`) match the cached plans (51 of 51).
- **Never posts, tested:** `mutate/command.test.ts` scans every non-test module of `mutate/` for imports of the API client, admin client, report job,
  plans push, calibration and export code, for `/internal` and `/admin` paths, API settings and any `fetch(`, and runs the command with `fetch` replaced by
  a function that throws. The only network a mutant uses is the package registry, through the normal executor.
- **Operators** (each applies the SAME per-line text change to the docs lines and to the plan step that quotes them, then the real grounding validator
  must accept the pair, else the mutant is `invalid`): package typo, non-existent version pin, renamed imported symbol, renamed method call (chains such
  as `client.messages.create(` follow), wrong deep import path, syntax error, misnamed option, and the experiment (previous major version through an
  executor override, never shown to the validator, reported apart). Lines are matched with the target's placeholders blanked out, because the plan
  holds the dummy key where the docs hold `YOUR_API_KEY`. Tests: 73 in `mutate/` (every operator yields a pair the real validator accepts, determinism,
  controls excluded when they fail, the never-posts guard, survivor reasons non-empty, sampling, render).
- **Levels** are the level the control reached (L1 install only, L2 build, L3 reached the vendor), not the target file's level.

### Results (seed `p9c`, 51 targets, concurrency 2, 32 minutes; 1 invalid, 97 not applicable)

50 of 51 controls passed (`hono-node` is skipped by design and is out of the statistics). Detected: **174 of 252 (69%)**, correct class **174 of 174**.
By level: **L1 12/12, L2 137/213 (64%), L3 25/27 (93%)**. By operator: package typo 49/49, version pin 49/49, renamed symbol 3/22, renamed method 2/20,
deep import 30/39, syntax error 41/44, misnamed option 0/29. Experiment (previous major): 5 of 45 failed, one with no rule matching (`vitest-node`,
class UNKNOWN: a failure the classifier cannot explain would go to the admin queue). The 12-target sample run first (11 controls, 49 tested, 39 detected)
showed that chained calls were missed by the method operator, which was fixed before the full run.

### Two findings about the harness itself

1. **`node --check` does not parse an ES-module `.js` file when no package.json says `"type": "module"`** (exit 0, nothing checked; reproduced with
   Node 22.16 on the host and 22.23 in the sandbox image). The L2 syntax check is therefore blind for that shape of file (`mocha-node`, `vitest-node`).
   Not fixed in production; the fix (parse a copy named `.mjs`) is part of the experimental flag.
2. **The Python imports check looks only at the top-level module**, so `import pkg.missing` passes.

### The proposed check, behind a flag, not enabled

`qsr-check-exports` (`CHECK_IDS.exports`, `planChecks(ir, { exports: true })`, `ExecuteDeps.exportsCheck`): named imports must exist on the loaded package,
dotted Python imports must import, ES-module `.js` files are parsed as modules; network blocked in-process while packages load; nothing a package exports is
called; TypeScript files skipped; a package that cannot be loaded is "unchecked", never a failure. New classifier rule `check.export_missing` (API_DRIFT)
with two synthetic fixtures built from the real output of the script. Before/after on the same mutants: **69% to 79% overall, L2 64% to 76%, L3 and L1
unchanged**, 24 newly detected, all classified as expected; mean control time unchanged. **One false positive in 50 controls** (`launchdarkly-node`: TypeScript
type imports written into a `.js` file). No workflow, `qsr execute` or `qsr plan` sets the flag. Enabling it changes what L2 means and needs your agreement,
a way for a target to opt out (or the compiler writing TypeScript snippets as `.ts`) and new wording on `/methodology`.

### Not done, on purpose

The production syntax check and the Python imports check were not changed. No operator for default imports (those SDKs show as not applicable for
`renamed_symbol`). The per-level denominators at L1 (6 targets) and L3 (5 targets) are small and the document says so.

## Go-live (after P9a)

State on 2026-10-17 (evening): CI was green on `39e3834` and `b9a981a`. The code of this section is `daa5ff0`. Production: the API is
`https://quickstartrot-api.onrender.com` (Render free instance; a cold start took 52 s), `/health` is 200 with the database up, the admin
Bearer request returned 200 (so `ADMIN_TOKEN` matches Render) and a signed request got past the HMAC check (400 for an empty body, not 401).
The website is deployed on Vercel at `https://quickstartrot.vercel.app` (`/`, `/bot`, `/methodology`, `/robots.txt`, `/sitemap.xml`,
`/api/badge/chalk-node`, `/api/og/resend-node` and `/admin/login` answered 200). The first Vercel build was skipped by the ignored build
step, because the newest commit only touched docs; a one-line change under `apps/web` (`5df8fc5`) started it (see `apps/web/README.md`).

**Plans in production:** `qsr plans push --all` imported 41 plans and found 10 already present (from the earlier real cycles); a second and a
third run imported 0 and reported all 51 already there. Note that `--dry-run` never asks the server, so it can only say `would_push` or
`no_local_plan`; "already present" shows only on a real push, which is idempotent. After this the model is not needed for the first full cycle.

### Ably hash drift: diagnosis

- **What changes:** one token in one code block per page, the Ably demo API key `xVLyHw.<id>:*****`. The first part (`xVLyHw`, the app) and the masked
  secret never change; the key id after the dot does: `-gbZ_g` (12:37 UTC), `ExKkfw` (13:20), `E9IfQw` (about 15:55), `ztp85A` (16:30 and again at
  16:43). It sits in `ably-python` block 12 (python, `AblyRealtime("xVLyHw.<id>:*****", ...)`) and `ably-node` block 6 (shell). It is a key the page
  generates for visitors, not a nonce in our crawl.
- **How often:** five crawls of each page 2 minutes apart (16:30 to 16:39) gave the identical hash every time, so the id is not per request. It
  changed at least four times between 12:37 and 16:30, so it rotates on a timescale of tens of minutes to hours. I could not measure the period more
  tightly without more days of crawls.
- **What does not change:** no block differs across the five crawls (no prose, version, date or tab-order change). Older extractions were not kept, so
  the comparison with the 12:37, 13:20 and 15:55 hashes is limited to the blocks the compiled plans cited; in those the key id is the only
  difference. Block count is stable (44 and 42).
- **Rest of the list:** all 51 enabled pages were crawled again at 16:40 to 16:44. 49 of 51 still match a plan that `qsr run` cached hours earlier, and
  no block on any other page matches the key shape `<id>.<id>:***`. So Ably is the only page that drifts.
- **Cost if left alone:** up to one compile per Ably page per cycle (about 3.4k tokens each, so at most 8 compiles, about 27k tokens a day, 18% of
  the 150k budget), and a `compile_deferred` queue item whenever the model is out.
- **Decision: option 1, scoped per target** (`extract.hashIgnore`, not a global normalizer in `content-hash.ts`). Implemented in `daa5ff0`:
  - Schema: an optional `extract.hashIgnore: [{ pattern, replaceWith }]` (at most 5 rules; a pattern up to 200 characters, a replacement up
    to 100; always applied globally; `$1` references work). Patterns are checked when the target loads: valid regex, no back-reference, no
    quantified group that contains a quantifier or an alternation. The field stays absent when not given, so no other target's config hash
    changes. Documented in `docs/TARGET-SELECTION.md` and the core README.
  - Hash: `contentHash(blocks, variants?, hashIgnore?)`. Without rules the payload is byte for byte the old one. Proof:
    `packages/core/src/content-hash.test.ts` recomputes the hash of 51 live extractions (a gzipped fixture; the expected hashes were made
    by the function before the field existed) with no rules, `undefined` and `[]`: 51 of 51 equal. The old function also passes those
    same cases (the new tests fail 17 of 71 against it, all of them about the new behaviour), and `committed-targets.test.ts` allows
    `hashIgnore` only on `ably-node` and `ably-python`.
  - Rule on the two Ably targets: `<5-8 chars>.<5-8 chars>:` followed (look-ahead) by three or more `*` becomes `<prefix>.KEYID:`. A real-looking
    key with the same prefix and no stars is NOT normalized (tested, as are one or two stars).
  - Where the hash is made: the crawler uses the target's rules; the compile route and `POST /admin/plans/import` recompute it with the
    stored (compile) or sent (import) target's rules. The stored extraction and the plan keep the verbatim text.
  - **Plan compiled with key id A, page now showing key id B** (`apps/api/test/hash-ignore.test.ts`): same normalized hash; the production
    compile returns the cached plan (`status ok`, `fromCache`, no model call, no `llm_calls` row, no COMPILER_ERROR), and the plan that
    comes back still carries key id A, which is what the executor runs (the executor never reads the extraction). Nothing on a cache hit
    re-runs the grounding validator. The one place that did was `plans import`: pushing the plan from id A with the extraction of id B
    failed with `file.content_mismatch` (shown by switching the fix off). For targets with rules only, the plan and the extraction now
    both go through the rules before the validator compares them; the plan stored is the one that was sent. A tampered command or any
    other change on the page is still refused (422 and 400). A hash made without the rule for such a target is refused by the compile
    route (400).
  - A crawler test (`extract.hash-ignore.test.ts`, two fixture pages that differ only in the key id) pins that the real extraction gives one
    hash with the rule, two without, and keeps the verbatim key.
  - **Hash churn:** `GET /admin/stats` and `qsr calibration-report` list every page with 2 or more distinct content hashes seen in the
    window ("Content hash churn") and flag 3 or more as VOLATILE (`PIPELINE.hashChurnFlagAt`). Canaries are left out. In production today:
    none.
- **Cost:** two local recompiles for the new hashes (about 17k tokens including one re-run on a stale build), then pushed.
- **Not done, on purpose:** option 2 (hash code blocks only) and a global normalizer.

### Review kit for the first full cycle

**What a healthy run looks like at 51 targets (55 tools with the canaries)**

- Plan job summary: `10 shards, 4 canaries.` and a table with 51 rows. `ready` for all 51 (every plan is in production already). A row that says
  `skipped` / `deferred: <reason>` means that page changed after the push and the model was out. No `pre_failed` rows. The plan job takes about 3 to 6 minutes (51 pages, 4 at a time).
- Execute: 10 shard jobs, about 5 tools each (shard 0 also has the other three canaries). Each shard about 3 to 8 minutes; the first run is slower
  (image pulls, no caches).
- Report headline: `50 passed, 0 failed, 1 skipped (51 tools, 4 canaries)` is the best case (50 + 1 = 51). The one skipped row is
  `hono-node` (a manual step, by design). Every extra skipped row says `deferred: ...` in the Plan column and needs a look. Six rows show `L1 / L2` and PASS (chai, socketio, jinja-intro, flask-install, rxjs, pydantic-install); five show `L3 / L3`
  (chalk, loguru, dotenv, anthropic-node, resend-node). Canary rows: `canary-fail-dep` FAIL `DEPENDENCY_RESOLUTION`, `canary-fail-drift` FAIL
  `API_DRIFT`, the two `canary-pass-*` PASS. Those two FAIL rows are correct.
- Whole workflow about 15 to 25 minutes (estimate 16 to 18 plus first-run overhead). Over 45 minutes is a stop sign.
- Status engine after one cycle: a PASS moves a tool from UNKNOWN to HEALTHY at once; hono and the deferred ones stay UNKNOWN. A first FAIL
  makes a tool DEGRADED, which is not public. The site currently shows the 9 tools of the earlier test cycles ("9 of 9 ... work", 4 at L3 and
  5 at L2); it fills out to 51 once the first full cycle is reported. BROKEN needs two failures in valid cycles and your review.

**First 30 minutes after it finishes**

1. The run is green in Actions, the `report` job finished, and the summary says `valid` (not `INVALID`).
2. `pnpm qsr calibration-report --days 1` (below). Cycles: 1 valid, 0 invalid. Harness error rate: 0 is expected; the bar is under 2%, and
   `qsr report` opens a `harness` issue at 5%.
3. Canaries: four lines, mismatched 0.
4. Compile deferrals: none expected, because every plan is already in production. Any deferral means a page changed after the push (or the
   budget guard tripped): look at Model tokens per day, and at Content hash churn.
5. UNKNOWN classifications: none expected. Anything there is a failure no rule matched, so a real run failed. Read its evidence line.
6. The admin page (Pipeline status and the queue). Baseline today: 10 informational items from the earlier test cycles (5 `skipped` for
   `hono-node`, the manual step, and 5 old `compile_deferred` for drizzle-node, loguru-python and vitest-node from days when the model was out).
   After the first full cycle only NEW items count. Incidents to review: 0.
7. Storage: the database gauge at a few percent and objects far below 1%.
8. The site: open two tool pages and one run page; a failing tool, if any, must say "verifying" with no cause.

**Commands (against production; the Render URL in `API_BASE_URL`, `ADMIN_TOKEN` from Render, both in `.env`)**

```
pnpm qsr calibration-report --days 1
pnpm qsr export --launch --md        # refuses anything not reviewed and confirmed; "No incident has been confirmed yet" is right
pnpm qsr plans push --all            # idempotent: 51 already_there, 0 imported (a dry run only says would_push)
```

How to read the report: **Cycles** (valid / invalid and why; an invalid cycle changed no status). **Harness error rate** (errors of ours as a share of
final attempts; the line under it says whether the bar is met). **Tools** (Pass, Fail, Skipped, Harness, Not run, Deferred, Stale; Flake is
the share of pass/fail flips, only meaningful after several cycles). **UNKNOWN classifications** (failures no rule matched, with the last line they
printed; each needs a rule). **Runs classified by the model** (accepted at 0.7 confidence or more with the evidence line in the log). **Compile**
(deferrals by tool and reason, stale-plan runs, model tokens per day). **Incidents** (open, confirmed, false positive, pending review).
**Canaries** (expected vs actual, mismatched must be 0). **Slowest tools** (median and max; the cap is 180 s per step). **Storage used**
(database, and Storage objects when visible).

**Stop the cron if any of these happens**

- Two invalid cycles in a row, or any canary mismatch you cannot explain.
- Harness error rate at or above 5% in a cycle, or above 2% over a full day (the `harness` issue opens at 5%).
- A tool shown as failing on the site without a confirmed incident, or any run log or page containing something that looks like a secret.
- More than a handful of queue items that are not Ably's `compile_deferred`, or an UNKNOWN classification that is not understood.
- The workflow taking over 45 minutes, a plan job timeout (20 minutes), or the API unreachable.
- A robots.txt, blocking or rate complaint from a vendor, an opt-out email, or Groq or Supabase usage above 70% of a limit.

One line to stop it: `gh workflow disable probe.yml --repo Aditya-tec/quickstartrot` (or Actions, probe, the three dots, Disable workflow). That also stops
manual runs; `gh workflow enable probe.yml --repo Aditya-tec/quickstartrot` brings it back. A run in progress is stopped with
`gh run cancel <run-id> --repo Aditya-tec/quickstartrot`. The cron is `17 */6 * * *`.

## Findings from P9a (scale to 50 targets, harden for scale, calibration tooling)

P9b (the 7-day review with real data) and P10 are not started. Nothing here is simulated: every number below is either measured
on this machine (labelled) or an assumption (labelled), and `node scripts/scale-estimate.mjs` recomputes the estimates.

### The targets

- **Protocol first:** `docs/TARGET-SELECTION.md` was written before any candidate was chosen. It records all 167 candidates with
  level, status and a one-line reason; the table is rendered by `node scripts/render-target-selection.mjs` from
  `docs/target-candidates.json` (kept by `scripts/set-target.mjs`) and the saved `qsr run` output. `/methodology` has a "How tools
  are chosen" section built from `TARGET_GOAL`.
- **Result:** 51 enabled (20 libraries and frameworks incl. the `hono-node` example, 28 vendor SDKs and API clients, 3 calibration
  targets), 16 written and run but disabled with a reason, 70 excluded, 30 passed the probe but were not run. Without the calibration
  targets the sample is 42% libraries and 58% vendors (aim: 40 and 60). **Levels:** only 5 are L3 (the calibration three, Anthropic
  Node and Resend Node). Most vendor quickstarts need an account to reach their API, and the harness never signs up for one, so 46
  are L2, and 6 of those pages show only an install command, so the run reaches L1 (the public page says L1). This is the honest
  picture: the "tested at L3" share in the launch numbers will be small.
- **How a target was enabled:** write the YAML, `qsr run <slug>` in real Docker, read the log, then enable only when the result is
  explainable. A PASS is enabled. A FAIL is enabled only when the cause is the docs; every failure seen was the plan input or our
  harness, so those 16 stay disabled (their notes say what happened). Scripts: `probe-docs-page.mjs` (robots, blocks, install
  command, root candidates), `draft-target.mjs`, `batch-run.mjs`, `apply-run-result.mjs`, `set-target.mjs`.
- **Calibration targets and `hono-node`** are marked in their notes: chalk, loguru and dotenv are calibration only; hono is the
  deliberate "needs a person" example (SKIPPED by design, never PASS or BROKEN).
- **Harness limits found while verifying (candidates for P9b, none fixed here):**
  - A plan that writes a REPL transcript (`>>>`, printed output lines) or a framework fragment (a top-level `return`) as a file fails
    the syntax check: huggingface-hub-python, arrow-python, upstash-ratelimit-node, twilio-node and twilio-python. A real run would
    report BROKEN for our input, so they are disabled. The cure is a way to pick the right block (`extract.variants`) or a classifier
    rule that sends this shape of syntax error to the harness side.
  - `kysely-node`: TS5112 when the plan writes a `tsconfig.json`. Docs that open with an interactive `npm init`
    (sendgrid-node, firebase-admin-node). The install step limit is 180 s (chromadb). A dummy token gets HTTP 500, not 401, from
    replicate. Docs that default to pnpm or bun (vercel-ai-node, prisma-node): the image ships npm only, and `extract.tab` did not
    change what the plan said, because the page content hash was the same.
  - Pages longer than the prompt budget (voyageai-python: 56 blocks, 27 not shown): the 20b model cited a prose block, and after the
    one grounding retry the plan became a manual step. A narrower `extract.root` or the larger model is the fix.
  - **Page hash drift:** the content hash of `ably.com/docs/getting-started/python` (and the node page) changed between crawls
    hours apart, and three crawls minutes apart agreed. Not understood yet (a per-visit demo key in the page is a guess). While it
    drifts, each change costs one compile; check it first in P9b.
- **Model quota:** each model has its own daily quota on Groq. `openai/gpt-oss-120b` ran out at about 180k tokens; the rest of the
  work used `QSR_COMPILER_MODEL=openai/gpt-oss-20b`,. A compile costs
  3.4k tokens on average (40 compiles, 136k, max 6.9k). The plan cache key contains the compiler version but not the model.

### Plans push (spares the second compile)

`qsr plans push <slug>|--all [--dry-run] [--include-disabled]` crawls the page, finds the plan compiled locally for that exact
content hash (`.qsr-cache`), and sends it with its extraction to `POST /admin/plans/import` (Bearer `ADMIN_TOKEN`). The API re-runs
the deterministic grounding validator against the extraction it was given, refuses a plan that fails or a wrong compiler version,
and stores an accepted plan under (tool, content hash, config hash, compiler version); a repeat is `already_there`. A forged
extraction can only create a cache entry for a hash no real page produces. Tested: valid import, tampered plan, wrong compiler
version, idempotent re-import, no or wrong token. Run for real against the local API and Postgres: 19 of 20 tools imported through
`pnpm probe:local --seed-plans`, and the plan job then compiled nothing for them.

**Compiles production still has to do** (`qsr plans push --all --dry-run` today): 49 of 51 enabled targets have a local plan for
the current page; **2 have none** (ably-node, ably-python: the hash drift above). At about 3.4k tokens each that is about 7k tokens,
**under one day** of the 150k budget (150k allows about 44 compiles a day). Without `plans push` it would be 51 compiles, about
174k tokens, **2 days**. Steady state is more modest than the first fill: assuming 4 docs changes per tool per month, about 7
compiles (24k tokens) a day. The push must be run just before the first cycle, since a page that changes in between needs a compile.

### Pipeline hardening

- **Groq circuit breaker (`qsr plan`):** the first answer that says the model is out for the day (a deferral or HTTP 429 with a
  Retry-After over `MAX_RETRY_WAIT_S`, or our own budget) opens it; every remaining tool is asked with `modelAllowed: false`
  (cache or last plan only, an informational skip otherwise), one log line says so. Fake-API tests: three kinds of first signal,
  `sleeps` is `[]`, the model is asked exactly once; a minute-limit does not open it. Before: a 429 without a long Retry-After made every
  later tool wait the default 30 s (`DEFAULT_RETRY_WAIT_S`) and retry, so 49 tools after the limit was about 25 minutes against a
  20-minute job timeout.
  After: 0 s.
- **`qsr report` concurrency:** 4 tools at a time (`REPORT_CONCURRENCY`; `--concurrency 1..8` exists to measure), cycle finish last,
  the summary rows read in manifest order. Unit test with 25 ms of latency on uploads and runs, 12 tools: 808 ms sequential,
  under 420 ms concurrent. **Local 20-tool run** (`pnpm probe:local --seed-plans --shards 5`, 24 results, real API and Postgres,
  no network latency): the report took **2.7 s at concurrency 1 and 2.1 s at 4**. Locally there is almost no round trip to hide,
  so this understates the gain; the gain scales with round-trip time (assumption: 5 calls per tool and 150 ms to Render is about
  18 s sequential and 5 s concurrent). Duplicate rows after the concurrent run: none.
- **Shards:** `min(10, ceil(tools / 4))` is 10 for 54 (50 tools and 4 canaries), about 5 tools per shard plus the guard canary.
- **A disabled or removed tool** (`enabled: false` or no file) keeps its rows and stops appearing in new cycles; syncing it back
  re-enables it, and `skipped` in the sync response says which targets were left out. Tested.

### Estimates for 50 tools (from `node scripts/scale-estimate.mjs`; measured inputs from 63 local runs, the rest assumed)

#### Shards and Actions time for 50 tools (+4 canaries)

- Shards: min(10, ceil(54 / 4)) = **10**, so about 5 tools per shard plus the guard canary.
- Wall time per cycle (plan, slowest shard, report; jobs run one after the other): **16 min** typical, **18 min** if every tool were as slow as today's p90. Cadence: 360 min, so 4% to 5% of it. The workflow's own limits are 45 min for the execute job and 20 for plan.
- Billed Actions minutes: **71 min per cycle**, **284 per day**, 8520 per 30 days (10800 at p90 speed). The repository is public, so standard hosted runners are free and unmetered; a private repository would have 2,000 free minutes a month.
- Concurrency: 10 execute jobs at once; the free plan allows 20.

#### Database and storage growth: 50 tools x 4 cycles x 30 days

Runs in the window: 54 x 4 x 30 x 1.05 (retries) = **6804**; step rows: 34020.

| Database (500 MB)        |         Rows |       Bytes | Basis                                                                               |
| ------------------------ | -----------: | ----------: | ----------------------------------------------------------------------------------- |
| runs + step_results      | 6804 + 34020 |     28.6 MB | 4.3 KB per run (p90 run 6.6 KB); the 4 KB stdout/stderr tails dominate              |
| storage.objects metadata |        20412 |     15.6 MB | 3 log files per run x 800 B; the same database, bounded by the 30-day log retention |
| doc_snapshots            |          250 |      1.9 MB | 4 docs changes a month per tool; 6.1 KB median page text x 1.3                      |
| compiled_plans           |          250 |      2.0 MB | 8.0 KB per plan                                                                     |
| probe_cycles             |          120 |    720.0 KB | 6.0 KB stored finish result                                                         |
| llm_calls                |          300 |    300.0 KB | 10 a day                                                                            |
| **Total**                |              | **49.1 MB** | **9.8%** of 500.0 MB                                                                |

| Storage (1 GB; cleanup aims under 800 MB) |     Bytes | Basis                                                                              |
| ----------------------------------------- | --------: | ---------------------------------------------------------------------------------- |
| step logs, typical                        |    2.3 MB | 357 B gzipped per run (measured), kept 30 days                                     |
| step logs, noisy                          |  201.7 MB | 10.0% of runs write 3 logs of 100.0 KB gzipped (the 256 KB cap)                    |
| step logs, theoretical ceiling            | 8505.0 MB | every step at the 256 KB cap, uncompressed: not reachable, shown only as the bound |
| docs diffs                                |    < 1 MB | one small text file per confirmed incident, kept                                   |
| traces                                    |         0 | none are produced in v1 (no L4); retention would be 14 days                        |

#### Beyond the window

Logs and their metadata are collected after 30 days, but the `runs`, `step_results`, `probe_cycles` and `doc_snapshots` rows are the public history and are kept. They add about **33.5 MB a month**. Adding the 15.6 MB of log metadata (steady), the database reaches 70% of the limit after about **10.0 months** and 100% after about **14.4 months**.

Smallest fix (proposed, not built): after 30 days, the nightly GC sets `stdout_tail` and `stderr_tail` to null on step rows of PASSING runs that no incident links. The tails are about 63% of a run's bytes, and a passing step's tail is not evidence of anything. That keeps the row counts (the public history) and moves the monthly growth to about 18.3 MB (assuming 85% of runs pass). Failing runs keep their tails.

**Verdict:** nothing exceeds 70% of a limit inside the 30-day window (database about 10%, logs 0.2% typical, 20% in a noisy case).
The database does cross 70% in the long run (about 10 months), because the history is kept on purpose. The smallest fix is
proposed above (null the tails of old passing steps); it is not built. `/admin/gc` now returns `freedBytes` (null when the
database cannot see storage), and the admin page has a "Pipeline status" section with storage gauges (database and objects, with a
warning in words above 70%), the last cycles, the harness error rate and model tokens.

### Calibration tooling

- `GET /admin/stats?days=N` and `qsr calibration-report --days 7` (Markdown), `GET /admin/export/launch` and
  `qsr export --launch [--json|--md]`. The launch export's schema admits only incidents with review CONFIRMED, so neither the
  API nor the CLI can print an unreviewed failure. Unit and integration tests use seeded data.
- The report shows the harness bar from the spec (under 2% over the last 3 days) next to the measured rate.
- `PIPELINE`, `FREE_TIER` and `TARGET_GOAL` in `packages/core/src/pipeline-facts.ts` are the single source of every figure on
  `/methodology` and `/bot`. `apps/web/src/lib/honesty.test.tsx` renders the pages with the real facts and with mutated facts and
  fails when a number is hand-typed; the leak spec and the axe checks were re-run (admin page included).

### Left for P9b

Run the pipeline in production; `qsr plans push --all` first; read `qsr calibration-report --days 7` after a week; decide about the
pages that drift, the plans that wrote REPL text (disabled targets above), the harness bar, and the L3 share.

## Findings from P8 (the website)

### Pre-flight results

- **Migration 0005** (pre-flight and stale runs excluded from `pass_rate_30d`) was already applied live; **migration 0006 was added
  and applied live** (`public_tools` +`last_run_id`, `last_outcome`, `last_reached_level`, `last_skip_reason`, `decided_30d`; new
  `public_run_history`, the newest 60 final runs per tool; `public_runs` recreated; `public_incidents` +`version_diff`, CONFIRMED
  only; `SELECT` granted to `anon` and `authenticated` on all four). Live RLS suite: 37 of 37.
- **A real leak was found and closed at the database layer.** Before 0006, `public_runs` sent `failure_class`, `failure_signature`,
  `failed_step_id` and every step's `exit_code`, `stdout_tail`, `stderr_tail` and `log_path` to anyone with the anon key, for
  failed runs nobody had reviewed. Now the view nulls them unless the run did not fail, the failure is about us (CRAWL_ERROR or
  COMPILER_ERROR), or the tool has a CONFIRMED incident (`details_published`). `apps/api/test/public-views.test.ts` (anon-role
  transactions) and the live RLS tests pin it.
- **Storage:** buckets `public-artifacts` (public) and `private-artifacts` exist. `pnpm smoke:storage` signs an upload like
  `/internal/uploads`, uploads gzip with the request shape `qsr report` uses (shared function `putToSignedUrl`), reads it back
  from the public URL (raw gzip, `application/gzip`, no `Content-Encoding`, `Access-Control-Allow-Origin: *`) and deletes it.
  **After a delete the public CDN still serves the file for up to `max-age=3600`** (upload sets `cacheControl: 3600`); the script
  checks the delete on the uncached authenticated endpoint. A real production log loads in the browser through the viewer.
  `decodeLog` also accepts already-decoded bytes (it checks the gzip magic number), in case a CDN ever applies `Content-Encoding`.
- **Crawler user agent** is `QuickstartRotBot/1.0 (+<BOT_INFO_URL>)`, read from configuration (`resolveBotUrl`; default
  `https://quickstartrot.vercel.app/bot`; must be an https URL without spaces, controls or `)`). Wired as `vars.BOT_INFO_URL`
  into the `plan` job of `probe.yml` and into `validate-targets.yml` only; the workflow tests fail if `execute` or `report`
  mention it.

### Decisions

- **One status function.** `publicStatus` (in `@qsr/core/public`) is the only place that turns a tool row, its last outcome and
  "has a confirmed open incident" into passing / failing / verifying / unknown / needs a person. The pages, the badge and the OG
  image all call it. "failing" requires a confirmed open incident, whatever the status string says.
- **`@qsr/core/public`** is a browser-safe subpath (zod and plain functions; a test walks its import graph and fails on a Node
  built-in). The main entry of core imports `node:crypto`.
- **Headline.** X of Y counts tested tools only (passing, failing, verifying). `SKIPPED` manual-stop tools are in neither X nor
  Y; they are listed under "Needs a person". Never-run tools are under "Not yet tested". Under the headline, passes are broken
  down by level: L3 (reached the vendor) versus L2 (installed, code parses and imports resolve, **not run against the vendor**)
  versus L1.
- **An unreviewed failure also hides which step failed**: its failed step shows "Being verified" instead of "Failed", and the
  streak reads "N failed in a row", never "failing".
- **Admin.** Login compares `ADMIN_TOKEN` in constant time (SHA-256 digests + `timingSafeEqual`), then sets an HMAC-signed,
  8-hour cookie (`httpOnly`, `secure`, `sameSite=strict`, path `/admin`); the cookie never holds the token. Middleware (Edge, Web
  Crypto) guards `/admin/*`; every server action re-checks the session. Failed logins are limited in memory (5 per 15 minutes
  per client): **on serverless that is per instance and resets when an instance is recycled**, so it only slows a guesser; the
  API's limiter on bad bearer tokens is the backstop. A reviewed incident stays on screen with its message until reload (Next
  refreshes the page after `revalidateTag`; `PendingList` keeps it).
- **Revalidation contract:** the API (P6) sends `POST` with the header `x-revalidate-secret`; the web route checks that header in
  constant time. Pages stay cached up to 5 minutes without it.
- **CSP keeps `'unsafe-inline'` for scripts** (Next's inline hydration payload; a nonce would make every page dynamic and give up
  ISR). Mitigations: no third-party script, no raw-HTML API anywhere (lint rule + test), `frame-ancestors 'none'`, `connect-src`
  limited to self and the Supabase project. The badge gets its own CSP (`default-src 'none'`). `'unsafe-eval'` is development only.
- **`htmlLimitedBots: /.*/`** in `next.config.ts`: Next 15.5 streams metadata for ordinary browsers, so a desktop Lighthouse
  run (and any non-bot link preview) saw no `<meta description>`. Now metadata is in `<head>` for everyone.
- **`/incidents` is `force-dynamic`** so the build never reads the database; `unstable_cache` still caches it for 5 minutes.
- **Local gotcha:** `.next/cache` survives rebuilds, so a `QSR_DATA=fixtures` build followed by a live build served the old
  fixture data until `.next` was deleted. It does not affect Vercel (a clean cache per build).
- **Submit.** `POST /api/submit` validates with `SubmissionBody` and `validateSubmissionUrl` (core), drops honeypot hits as if they
  worked, forwards to the API with up to 4 retries on network errors and 502/503/504 (waits 2, 3, 5, 7 s, 8 s per attempt: inside
  a 60-second function), and forwards the visitor address (`x-real-ip`) as `x-forwarded-for` so the API's 5-a-day limit is per
  visitor (needs `TRUST_PROXY=true` on Render, the default).

### Numbers (2026-10-17)

Unit tests in apps/web: see `pnpm --filter @qsr/web test`. Playwright: desktop + 375 px projects, every page, axe in light and
dark with zero violations; leak tests for every page (HTML and RSC), the badge, sitemap, robots and the DOM; revalidation test.
Lighthouse on the production build with fixtures: mobile performance 91 to 95, everything else 100 (desktop all 100); the
remaining mobile performance gap is first and largest contentful paint under Lighthouse's simulated slow 4G, mostly the shared
103 kB of framework JavaScript.

### What P9 should know

- The live data had 10 tracked tools, 9 testable, 4 at L3 and 5 at L2; one (hono) stops at a manual step.
- Scale: the home page loads `public_tools` and the newest 28 runs per tool in two paged requests (PostgREST caps a response
  at 1000 rows; `SupabaseDataSource` pages with `range`). At 50 tools that is 1400 history rows: fine. Past a few hundred tools,
  add a database-side aggregate instead.
- The admin queue shows signatures and draft summaries of unreviewed incidents on purpose; it is the only place that does.

## P7 follow-up: the first real runs, and the tidy-up commit

### What the first real runs showed (2026-10-16, probes #1 to #5)

- **It works in production.** Real Actions runs on the deployed API: valid cycles, runs and step results in Supabase, 25 of 33
  step logs uploaded and publicly readable (gzip). The two things listed as unverified in the P7 notes are now verified: the
  multipart `PUT` to a signed Storage URL works **without** an `apikey` header, and the report job needs no Supabase key.
- **Setup mistake that cost one run:** `API_BASE_URL` was first added as a _secret_; the workflow reads a _variable_. The message
  named it ("API_BASE_URL must be set"), which is what it should do.
- **Two Groq limits, not one.** Run #3 deferred 3 tools on the per-minute limit (TPM 8,000 on `openai/gpt-oss-120b`: two
  parallel compiles of 3-4k tokens each exceed it); run #4 deferred 2 on the **daily** limit (TPD 200,000), because the key is
  shared with local development. `/internal/compile` handled both as designed: `deferred`, queue item, no status change.
  The API's budget guard cannot see tokens spent by other clients of the same key; a second key (Render only) fixed it.
- **Timings (5 runs, 2-3 shards):** plan 86-113 s (Playwright install 20-46 s, the crawl+compile 24-80 s), execute 30-70 s per
  shard (about 15 s of that is checkout + pnpm + install, the rest is the tools), report 50-76 s (40-63 s in `qsr report`
  itself: three sequential API calls per tool against a free Render instance), whole run 229-247 s. Artifacts are tiny:
  plans 7-15 KB, results 2-12 KB per shard.
- **Slowest tools:** `drizzle-node` 21.0 s and `vitest-node` 18.2 s (both are one big `npm install`, 16.6 s for the slowest
  step); everything else is 2.4-5.1 s. `hono-node` stops at its manual step (SKIPPED, NEEDS_CREDENTIALS).
- **Possible later savings, none urgent:** cache the Playwright browser in the plan job (about 20-45 s); post runs in `qsr report`
  with a small concurrency; a Groq `Retry-After` above 60 s is still slept for 60 s inside the API before it defers, which is
  pointless for a daily limit (run #4's plan took 80 s for that reason). Left alone because a test pins the 60 s cap.

### The tidy-up commit

- **Every job runs on `ubuntu-24.04`** (all 11 jobs, 6 workflows). `ubuntu-latest` was due to move to Ubuntu 26 on 2026-10-19.
  A workflow test requires the exact label and forbids `ubuntu-latest` anywhere.
- **Node 20 warnings removed.** Each flagged action was moved to the newest release whose `action.yml` declares
  `runs.using: node24` (read at the pinned SHA), every SHA resolved with `git ls-remote` and re-checked against the GitHub API,
  and every input our workflows pass was confirmed to still exist. The new releases are recent: `setup-node` 7.1.0,
  `upload-artifact` 7.0.2 and `download-artifact` 8.0.2 are 9 days old, `codeql-action` 4.39.0 is 1 day old (the previous 3.39.0
  was released the same day it was pinned). Full list in the commit message.
- **`qsr plan` compiles one tool at a time.** Pages are still crawled together (4, one per domain); once they are in, compile calls
  run sequentially in slug order, so the order is deterministic. A rate limit (HTTP 429 or 5xx from the API, or a `deferred`
  answer with `llm_unavailable`/`llm_timeout`) waits for its Retry-After (30 s if none) and retries **once**; a Retry-After over
  2 minutes (a daily limit) and our own `llm_budget` are not retried. After that the tool is deferred exactly as the budget guard
  defers it: the last accepted plan flagged stale, else an informational skip. The whole phase is capped at 15 minutes; tools
  not reached are asked once with `modelAllowed: false` (cache or stale plan only, a miss is `deferred` with `llm_timeout`).
  Deferral is never a `COMPILER_ERROR` and never changes a status (the plan job posts no runs).
- **API/compiler support for that:** `LlmError.retryAfterS` keeps the provider's last Retry-After; the `deferred` response has
  `retryAfterSeconds`; `CompileBody.modelAllowed` (default true); `ApiError.retryAfterS` reads a numeric `Retry-After`.

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

## Findings from P10a (the launch kit)

- **A transient incident could have been published.** Four `NETWORK_TRANSIENT` or `TIMEOUT` failures in a row open an internal incident (spec section 14), and `confirmIncident` did not look at its class, so a reviewer could have made it public as the vendor's failure. It now refuses any class outside `VENDOR_FAILURE_CLASSES` (409); the methodology page and `docs/DISCLOSURE.md` say so. This is stricter than the spec, not in conflict with it.
- **A comment named a test that did not exist.** `pipeline-facts.ts` listed an "issue-templates test" for `optOutHours`; none existed, so the 24 hours in the opt-out form were unpinned. `packages/cli/src/launch-docs.test.ts` now pins both issue forms, CONTRIBUTING, the disclosure policy and its email, and the walkthrough to the constants.
- **The hand-written recommendation in `DETECTION-POWER.md` was stale** (three shadow targets; it is four since `slack-node`, whose results predate its shadow step). Corrected. The approved Candidate B wording is now compared by a test with what the site and the README print, so they cannot drift apart.
- **Cold start.** The Render API took 42.5 s and 52.5 s to answer `/health` after it had slept; warm it took under a second. In the same runs every public page answered normally (static pages 17-35 ms from the CDN, tool and incidents pages about 0.3 s, the home page 1.6 s the first time and 0.6 s after: it is rendered on demand because of its filters), because the pages read the public database views and never the API. Only `/submit` waits for the API; it now wakes it when the page opens. The home page is the slowest first visit; making it static with client-side filters is a possible later change.
- **Made-up slugs.** The badge, the share image and the tool page used a per-slug cached lookup, so each unknown slug cost its own queries and cache entry; they now check one cached list of tracked slugs first.
- **Decided afterwards:** the licence is MIT, copyright Aditya Kalambe (2026-10-18). **Not built, on purpose:** disclosure tracking in the admin page (spec section 16): `docs/disclosure-log.md` is read by the launch check instead. **Not guarded:** `/runs/<id>` still looks an id up per request (a made-up id costs one cached lookup).
