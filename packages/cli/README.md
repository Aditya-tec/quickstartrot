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
qsr report --results results/ --plans plans/ --cycle <id>
```

- **plan** wakes the API, syncs the targets, creates the cycle (idempotent on `GITHUB_RUN_ID` + attempt), crawls every
  enabled target (concurrency 4, one page per domain at a time) and asks `/internal/compile` for a plan. It writes
  `plans/<slug>.json` (a `PlanFile`: ready, pre_failed or deferred) and `plans/manifest.json`, and prints `cycle` and
  `shards` to `$GITHUB_OUTPUT`. A plan from a budget deferral is run and flagged `stale`.
- **execute** runs its shard's tools one after another in Docker, retries a transient failure once after 60 s, guards each
  tool with a watchdog, and writes `results/<slug>-<attempt>.json` plus redacted logs. Shards other than 0 also run
  `canary-pass-node` into `results/guards/shard-N/`. It exits non-zero only on a harness crash (no Docker, unreadable plans).
- **report** uploads gzipped logs through signed URLs, posts each run, posts pre-failed entries, reports a HARNESS_ERROR for
  a planned tool with no result, finishes the cycle and writes the outcome table to `$GITHUB_STEP_SUMMARY`. An invalid cycle
  or a harness error rate above 5% opens (or comments on) the `harness` issue. It exits non-zero only if it could not finish;
  every call is idempotent, so the job can be re-run.

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
