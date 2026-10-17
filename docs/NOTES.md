# Notes for later phases

Decisions and findings that are not in the spec and not obvious from the code. Newest first. The spec
(`QuickstartRot - Build Spec.pdf`) remains the source of truth; where this file adds to it, it says so.

## Carry-forward (requested, not implemented yet)

Nothing is carried forward from P8 that P9a left open. The P9 request to choose the 50 targets for an L3 path was done in P9a (see
below): `chalk-node`, `loguru-python` and `dotenv-python` are calibration targets only, and the L3 share is small on purpose
(most vendor quickstarts need an account).

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
