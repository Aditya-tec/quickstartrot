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

### P9: choose the 50 targets for an L3 path

Bias the target list toward funded devtool SDKs whose quickstart can be tested at L3 with a dummy key
(auth-error-as-pass). `chalk-node`, `loguru-python` and `python-dotenv` stay as **calibration targets
only**: they have no API to reach, so they prove the pipeline works, not that a vendor's endpoint is
wired up. Resend is the model case: its SDK prints the 401 and exits 0, so the log shows the client
reached the endpoint.

### The compiler truncates the docs page, and nothing records it (checked 2026-10-16)

What the code does today:

- `buildDocsData` (`packages/compiler/src/prompt.ts`) stops adding blocks once the JSON would exceed
  `maxDocsChars` (10,000 characters, sized for Groq's 8,000-token request limit) and puts
  `omittedBlocks: N` **inside the prompt data only**.
- The system prompt never mentions `omittedBlocks`, so the model is not told to account for it.
- `CompiledPlan`, `StepIR`, `groundingReport` and the cache entry carry **no** truncation flag.
  A truncated plan is stored, cached and executed exactly like a complete one: **it is silently
  treated as complete.**
- The validator checks the plan against the FULL extraction, so it cannot notice either.

How often it happens (the 10 real targets, 2026-10-16): fastify-node 33 of 65 blocks omitted,
loguru-python 36 of 76, pytest-python 5 of 38; the other seven are complete. The omitted blocks are
the tail of the page (later sections), and the quickstart is normally at the top, so the plans were
fine in practice, but nothing guarantees that.

Recommended design (P6, when `compiled_plans` is touched anyway):

1. Record it: `compiled_plans.truncated boolean not null` and `omitted_blocks int` (also on the
   `CompiledPlan` type). Set from `buildDocsData`'s result, not from the model.
2. Tell the model: one sentence in the system prompt ("DOCS_DATA may end early; `omittedBlocks` counts
   the blocks left out; do not assume the page has no further steps"), with a `COMPILER_VERSION` bump.
3. Surface it: `/runs/[id]` shows "page truncated: N blocks not shown to the compiler"; a truncated
   plan can never be the evidence for a published BROKEN without a human looking at that.
4. Longer term, drop the omitted blocks smartly (keep headings, drop prose far from code) or raise the
   budget when the provider allows it.

## Findings from P4 (executor, images, canaries)

- **`docker cp` is not used for files.** The spec says to `docker cp` write_file content into the
  container. Verified on Docker 29: `docker cp` creates the file as `0:0` (root), and the unprivileged
  runner (uid 1001, all capabilities dropped) then gets `Permission denied` appending to it or
  rewriting it, so `append_file` and any tool that later edits a copied `package.json` would break.
  Files are written with `docker exec -i ... cat >` as the runner, after `realpath -m` resolves symlinks
  inside the container and refuses anything outside `/work` (exit 97, reported as `HARNESS_ERROR`).
- **`RunResult` is exactly spec section 9.** The extra `resolved` field added in P1 was removed;
  version-drift data lives in `runnerEnv.resolved` as a JSON string (`RUNNER_ENV_KEYS`, `parseResolved`).
- **A manual stop is `outcome: FAIL`, step `SKIPPED`.** The spec's classifier table lists "plan stopped at
  a manual step before the target's level" as a signal for `NEEDS_CREDENTIALS`, and failure classes only
  attach to failed runs. If the owner prefers `SKIPPED` for the run, the classifier input changes. A manual
  step reached AFTER the target level was already proven is a `PASS`.
- **`reachedLevel` 2 currently means "files written", not "the snippet imports or compiles".** The spec's
  L2 is "imports, compiles or typechecks", and no step performs that: the plan model has no executing
  step between writing a file and running it. L2-only targets (zod, pytest, vitest, fastify, drizzle)
  therefore prove: install works and the docs' code could be written. A sound fix is a harness-owned
  static check after the writes (`node --check` plus resolving each import for Node; `py_compile` plus
  `importlib.util.find_spec` for Python), never importing the file because that would run top-level code.
  Decide before the level badge is shown publicly.
- **npm 10 prints `npm error`, not `npm ERR!`.** The classifier (P5) rules in spec section 10 quote the old
  prefix; match both. The 404 canary prints `npm error code E404` and
  `npm error 404 Not Found - GET https://registry.npmjs.org/<name>`.
- **Signature normalization needs to strip npm's log file name** (`~/.npm/_logs/2026-10-16T07_51_26_705Z-debug-0.log`),
  which contains a timestamp, or two identical failures get different signatures.
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
