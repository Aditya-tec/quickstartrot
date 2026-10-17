# @qsr/cli

The `qsr` command line (spec sections 12 and 15). From the repo root, `pnpm qsr <command>` builds what it needs and runs it.

## Commands

| Command                           | Phase | Status      |
| --------------------------------- | ----- | ----------- |
| `qsr crawl <slug>`                | P2    | implemented |
| `qsr compile <slug>`              | P3    | implemented |
| `qsr run <slug>`                  | P4    | implemented |
| `qsr plan` / `execute` / `report` | P7    | implemented |
| `qsr gc`                          | P7    | implemented |
| `qsr validate`                    | P7    | implemented |
| `qsr plans push`                  | P9a   | implemented |
| `qsr calibration-report`          | P9a   | implemented |
| `qsr export --launch`             | P9a   | implemented |
| `qsr mutate`                      | P9c   | implemented |

```sh
pnpm qsr crawl zod-node                  # human summary: title, hash, block counts, code block list
pnpm qsr crawl zod-node --json           # full Extraction as JSON on stdout (logs go to stderr)
pnpm qsr crawl resend-node --trace-dir ./traces
```

Exit codes: `0` ok, `1` crawl failed (`CRAWL_ERROR (<reason>)` on stderr), `2` usage or invalid target file.

## The probe pipeline (P7)

Three commands, one per job of `.github/workflows/probe.yml`. Trust is split between them (spec section 12).

```sh
# plan job (has API_BASE_URL and INGEST_HMAC_SECRET; never runs docs code)
qsr plan --out plans/ [--shards N] [--only a,b]
# execute job (NO secrets, NO route to the API; one per shard)
qsr execute --plans plans/ --shard N --out results/
# report job (has the secrets; only reads JSON)
qsr report --results results/ --plans plans/ --cycle <id> [--concurrency 1..8]
```

- **plan** wakes the API, syncs the targets, creates the cycle (idempotent on `GITHUB_RUN_ID` + attempt), crawls every
  enabled target (concurrency 4, one page per domain at a time), then asks `/internal/compile` for a plan one tool at a time in
  slug order (a rate limit waits for its Retry-After, default 30 s, and retries once; the whole phase is capped at 15 minutes;
  whatever is not compiled in time is deferred, never failed). It writes
  `plans/<slug>.json` (a `PlanFile`: ready, pre_failed or deferred) and `plans/manifest.json`, and prints `cycle` and
  `shards` to `$GITHUB_OUTPUT`. A plan from a budget deferral is run and flagged `stale`.
- **execute** runs its shard's tools one after another in Docker, retries a transient failure once after 60 s, guards each
  tool with a watchdog, and writes `results/<slug>-<attempt>.json` plus redacted logs. Shards other than 0 also run
  `canary-pass-node` into `results/guards/shard-N/`. It exits non-zero only on a harness crash (no Docker, unreadable plans).
- **report** uploads gzipped logs through signed URLs, posts each run, posts pre-failed entries, reports a HARNESS_ERROR for
  a planned tool with no result, finishes the cycle and writes the outcome table to `$GITHUB_STEP_SUMMARY`. An invalid cycle
  or a harness error rate above 5% opens (or comments on) the `harness` issue. It exits non-zero only if it could not finish;
  every call is idempotent, so the job can be re-run.

**Plans push (P9a).** `qsr plans push <slug>|--all [--dry-run] [--include-disabled]` (needs `API_BASE_URL` and `ADMIN_TOKEN`) crawls
the page, takes the plan that `qsr run` or `qsr compile` cached locally for that exact content hash, and sends it with its
extraction to `POST /admin/plans/import`. The API re-validates it, so a plan compiled once locally is not compiled again in
production. `--dry-run` says what would be pushed and which tools have no local plan.

**Calibration (P9a).** `qsr calibration-report --days 7` prints the Markdown a calibration review reads (cycles, harness error
rate, per-tool counts and flake score, every UNKNOWN with its evidence, compile deferrals, incidents, canaries, slowest tools,
model tokens per day, storage). `qsr export --launch [--json|--md]` prints the numbers for the launch post from reviewed and
confirmed incidents only. Both need `API_BASE_URL` and `ADMIN_TOKEN`.

The plan job has a circuit breaker for the model: once one answer says it is out for the day (a long Retry-After or our token
budget), every remaining tool gets its cached or last plan only, with no further waiting.

**Detection power (P9c).** `qsr mutate <slug>|--all [--sample N] [--seed S] [--operators a,b] [--concurrency 2]` mutation-tests the monitor, locally and only
locally. It takes each target's cached extraction and accepted plan (`qsr plans push` leaves both in `.qsr-cache`), makes one deterministic change
to the docs code and to the plan step that quotes it, checks that the real grounding validator still accepts the pair, runs the quickstart in the
usual Docker sandbox, and records whether it failed and how the classifier labelled it. Controls (the unmutated plans) run first. It never calls the
API (a test pins that), never crawls and never asks a model. `--plan-only` counts the mutants; `--baseline <json> --exports-check` re-runs the
survivors with the experimental export check on; `--render <json> [--compare <json>]` writes `docs/DETECTION-POWER.md` and
`docs/detection-power.json` from saved results. See `docs/DETECTION-POWER.md`.

Other commands: `qsr gc` (nightly `POST /admin/gc`) and `qsr validate [--only a,b] [--crawl]` (Zod-checks every target,
refuses non-public docs URLs and credential-like placeholders; `--crawl` is a dry run with no compile and no secrets).

The API client (`createApiClient`) signs every request with HMAC, wakes a sleeping Render instance (`wakeApi`), and retries
502/503/504 and network errors with backoff, re-signing each attempt.

Run the whole pipeline on this machine, against a local API and Postgres: `pnpm probe:local` (see `scripts/probe-local.ts`).

## Library

`loadTarget(dir, slug)`, `loadAllTargets(dir, { canaries })` and `parseTargetFile(file)` read `targets/<slug>.yaml` (or `targets/_canary/`), validate with the `Target` schema from `@qsr/core`, and require the slug to equal the file name.

## `qsr compile`

```sh
pnpm qsr compile zod-node                # crawl, compile (or reuse the cached plan), print steps and the grounding report
pnpm qsr compile zod-node --json         # { plan, fromCache, llmCalls } as JSON on stdout
pnpm qsr compile zod-node --refresh      # ignore the cached plan, compile again, store the new one
```

Plans are cached in `.qsr-cache/` (git-ignored), keyed by (slug, content hash, `COMPILER_VERSION`). A second run on unchanged docs makes **zero model calls**; the logs on stderr show `plan cache hit` and no `llm call`. `GROQ_API_KEY` is only needed on a miss; set `QSR_COMPILER_MODEL` to change the model. Exit code 3 means the model was unreachable or refused the request.

## `qsr run`

Crawl, compile (or load a canary's golden plan), execute in Docker, print the step timeline and `runner_env`. No database, no API.

```sh
pnpm qsr run zod-node --local-images     # build/use qsr-node:local from docker/*.Dockerfile
pnpm qsr run zod-node                    # use the target's runtime.image (ghcr.io/<owner>/qsr-node:22)
pnpm qsr run canary-fail-drift --local-images
```

Results go to `.qsr-runs/<slug>-<timestamp>/` (`<slug>-1.json` plus one redacted log per step). Flags: `--image <ref>`, `--json`, `--refresh`, `--out <dir>`. Canaries (`canary-*`) are served from `fixtures/docs-site` on port 4177 and checked against `targets/_canary/canaries.json`: a canary that gives its expected answer exits `0` even when the expected answer is FAIL.

Exit codes: `0` pass (or an expected canary answer), `1` fail / rejected plan / canary mismatch, `2` usage, `3` model error, `4` harness error, Docker not reachable, or port 4177 busy.
