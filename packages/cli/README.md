# @qsr/cli

The `qsr` command line (spec sections 12 and 15). From the repo root, `pnpm qsr <command>` builds what it needs and runs it.

## Commands

| Command                           | Phase | Status      |
| --------------------------------- | ----- | ----------- |
| `qsr crawl <slug>`                | P2    | implemented |
| `qsr compile <slug>`              | P3    | implemented |
| `qsr run <slug>`                  | P4    | implemented |
| `qsr plan` / `execute` / `report` | P7    | not yet     |

```sh
pnpm qsr crawl zod-node                  # human summary: title, hash, block counts, code block list
pnpm qsr crawl zod-node --json           # full Extraction as JSON on stdout (logs go to stderr)
pnpm qsr crawl resend-node --trace-dir ./traces
```

Exit codes: `0` ok, `1` crawl failed (`CRAWL_ERROR (<reason>)` on stderr), `2` usage or invalid target file.

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
