# @qsr/executor

Runs a compiled Step IR plan inside one resource-capped Docker container per tool and returns a `RunResult` (spec section 9). It records what happened; it **never classifies** failures (that is `@qsr/classifier`) and never talks to the network itself: the Docker daemon does, on behalf of the container.

Pure library: no HTTP server, no database. Docker is injected.

## Public API

```ts
import { createDockerCli, executePlan, persistRunResult } from '@qsr/executor';

const result = await executePlan(
  {
    target,
    ir,
    image: 'ghcr.io/aditya-tec/qsr-node:22',
    outDir: './results',
    cycleId,
    attempt: 1,
    planId: null,
    snapshotHash,
  },
  { docker: createDockerCli(), log },
);
await persistRunResult('./results', result); // results/<slug>-<attempt>.json, logs under results/<slug>-<attempt>/
```

`DockerClient` is the only way the executor touches Docker: unit tests use a fake, `createDockerCli()` shells out to the `docker` binary.

## What a run does

1. Resolves the image (pulls it if missing) and records the digest it actually ran.
2. `docker run -d --name qsr-<runId> --user 1001:1001 --memory 2g --cpus 2 --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges -w /work <image> sleep infinity`. No `-e`, no volumes, no custom network, no privileges. The `docker` CLI itself is started with an allowlisted environment, so host secrets cannot leak through it either.
3. Captures `runner_env` (tool versions, registry, OS, docker version, limits), then the harness project setup (`npm init -y`, plus `"type": "module"` only when a written `.js` file uses ESM and the plan writes no `package.json`).
4. Runs the steps in order; the first failure stops the run.
   - `shell` / `run`: `docker exec ... bash -lc 'exec timeout -k 5 "$1" bash -c "$2"'` with the step timeout, capped by the target's overall budget.
   - `write_file` / `append_file`: through the container as the runner user, after `realpath -m` resolves symlinks inside the container and refuses anything outside `/work` (`HARNESS_ERROR`). `docker cp` is not used: it creates root-owned files the runner cannot modify.
   - `set_env`: appended as a single-quoted `export` to `~/.qsr_env`, sourced by every later login shell.
   - `manual`: the step is `SKIPPED` (with `skipReason: 'manual_step'` on the step result) and the plan stops. The RUN is `SKIPPED` if the target level was not reached yet, never a `FAIL`: a person has to act, nothing in the vendor's quickstart broke. A manual step after the target level was already proven leaves the run a `PASS`.
   - **harness checks** (below) run after the last file write and the last install, before anything else that follows.
5. After the last install step it captures the resolved top-level dependencies (`npm ls --depth=0 --json` / `pip freeze`) into `runnerEnv.resolved`.
6. `docker rm -f` in a `finally` block, always: on success, failure, timeout, crash and abort.

### Evaluating a step (`expect.ts`)

Exit code, `stdoutIncludes`, and auth-error-as-pass exactly as in the spec: with `authErrorIsPass`, a non-zero exit passes only if the output matches an auth pattern (`HTTP 401/403`, `unauthorized`, `invalid api key`, `invalid_api_key`, `authentication failed`, `missing api key`, `forbidden`) **and** no drift pattern (`is not a function`, `Cannot find module`, `ModuleNotFoundError`, `ImportError`, `AttributeError`, `SyntaxError`). The matched pattern is stored on the step result. 100% coverage is enforced.

### Output (`sink.ts`)

Line by line, redacted before anything is stored (`redact` in `@qsr/core`): dummy keys, secret-looking tokens, the home path, IPs, ANSI. At most 256 KB of log per step goes to a file; the last 4 KB of each stream is kept as `stdoutTail` / `stderrTail`; one over-long line is cut instead of buffered.

### Levels and the harness checks (what "L2" means)

| Level | Proven by                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| L1    | every install step of the plan exited 0                                                                                                         |
| L2    | L1 **and** the harness checks passed: the docs' code parses and every static import resolves                                                    |
| L3    | L1, no failed check, the `run` step met its `Expect` (including auth-error-as-pass) **and its output shows evidence that a vendor was reached** |

Writing a file proves nothing about it, so it is **not** level 2. After the last `write_file`/`append_file` AND the last install step (imports resolve from what is installed by then), the executor runs two **harness-owned** steps, of kind `harness_check`, with the ids `qsr-check-syntax` and `qsr-check-imports`. They are not part of the plan: the plan schema has no such step kind, so neither the LLM nor the docs can add, remove or change one. Their scripts are constants in `check-scripts.ts`, sent to the container on stdin; they only read files under `/work` and never execute the snippet or import the vendor package.

| Language | `qsr-check-syntax`                                                                                                                                    | `qsr-check-imports`                                                                                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node     | `node --check` on every written `.js/.mjs/.cjs`; `.ts/.mts/.cts` with `tsc --noEmit --noResolve`, keeping **only** the syntactic diagnostics (TS1xxx) | every static `import`/`export … from`/`require('literal')`: `node:` and builtins pass; relative ones must exist; bare ones must resolve from `/work/node_modules` (a deep import must name a file the package has); `require()` in an ES module fails |
| Python   | `python -m py_compile` on every written `.py`                                                                                                         | `importlib.util.find_spec` of the **top-level** module of every static import (found by `ast`); relative imports must point at something written; an import inside `try: … except ImportError` is optional                                            |

Choices worth knowing:

- **TypeScript is checked with `tsc` but only for syntax.** A docs snippet is not a project: it has no `tsconfig` and none of the `@types` packages, so a full type check fails correct code. `tsx` has no check mode. The image's global `typescript` is v7 (the native port, no JS API), so the check runs its `tsc` binary and filters to TS1xxx.
- **Not checked, on purpose:** dynamic `import()`, non-literal `require(name)`, `importlib.import_module`, `__import__`, and package.json `imports` aliases (`#x`). Those are found by the `run` step, or not at all at L2.
- **The harness cannot fail the docs.** A check that exits with anything but 0 (clean) or 1 (findings in the docs' code), such as a crash, a timeout or a missing compiler, is a `HARNESS_ERROR`.
- **Failure text is the check's output.** A failed check makes the run a `FAIL` at level 1 with `failedStepId` set to the check's id, and the `run` step never starts.
- **L3 needs evidence (harness version 3).** A run step that merely exits 0 proves the snippet ran, not that a vendor was reached. L3 needs an auth pattern in the step's output: one of the spec patterns (`AUTH_PATTERNS`) or a registered vendor pattern (`VENDOR_AUTH_PATTERNS`, each added only from output a real run produced, with a fixture in `packages/core/fixtures/vendor-output/`). The evidence is recorded on the step (`matchedAuthPattern`) whatever the exit code, and a drift pattern (an import error, "is not a function") printed beside it takes it away. A run step that passes without evidence passes the run but is capped at the level the checks proved, and `runner_env.l3` says why: `no_evidence`, or `local` for a target that declares `expect.localOnly` (a library with no vendor API). Neither is a failure and the status engine does not read it.
- **Shadow-L3.** A target with `l3: { mode: shadow, reason }` is compiled at its own level (so its plan has the L3 step) but SHOWN at level 2. Its `run` step is held back, and run ONCE after every normal step, check and the shadow export check, only when the run passed. What it said (a verdict against the evidence rule, the pattern, the exit code, the observed line, redacted and clipped) is recorded as `shadowL3` on the last step. It is not a step of the run: it cannot change the outcome, the failed step, the level, the classification, a status, an incident, a badge or a public page (`shadow-l3.test.ts`, `apps/api/test/shadow-l3.test.ts`). The probe never retries a failure at a run step, so a target makes at most one vendor request per cycle. `qsr l3-shadow-report --days N` reads the records; promoting a target (removing `l3:` from its file) is a person's decision.
- **Harness version.** Every run records the version of these checks (`harnessVersion`, the constant `HARNESS_VERSION` in `@qsr/core`; 1 is everything before versioning, 2 is the current). Bump it whenever a change to a check can change a verdict. Version 2 changed two things: a `.js` file that is an ES module (it has `import`/`export` and no `package.json` says otherwise) is now parsed as a module (v1's `node --check` exited 0 without parsing it, so a broken file of that shape passed); and a dotted Python import (`import pkg.sub`, `from pkg.sub import x`) resolves the full dotted path, not only the top-level module. A missing submodule fails the imports check with `ModuleNotFoundError: No module named 'pkg.sub'`, which the classifier maps to **API_DRIFT** (rule `check.python_submodule_missing`, the same class as a Node deep import that names a file the package does not have). The status engine never counts failures across harness versions as consecutive, so a version bump cannot open an incident by itself.
- **Shadow export check.** With `ExecuteDeps.shadowExportCheck` (set by `qsr execute`, so by every production execute job) the experimental `qsr-check-exports` runs last, after the normal checks and any run step, and its answer is recorded only on the `qsr-check-imports` step as `shadowExportCheck` (`pass`/`fail`/`skipped`, the missing names, a note). It never changes a step outcome, the level, the classification or the run outcome; nothing reads it except `GET /admin/shadow` and `qsr shadow-report`. A target can opt out with `harness: { skipExportCheck: true, reason }` (a reason of at least 10 characters is required); the check then reports `skipped` with that reason. It recognises a TypeScript snippet by a `ts`/`tsx` fence or TypeScript-only syntax, checks it as TypeScript and skips type-only imports (their names have no run-time export).
- If the plan writes no `.js/.mjs/.cjs/.ts/.py` file there is nothing to check and no L2 is claimed; a passing `run` step is still L3.

### Outcomes

`PASS`, `FAIL` (a step or a harness check failed), `SKIPPED` (a manual step stopped the plan before the target level), `HARNESS_ERROR` (Docker, a bad path, an executor exception: ours, never the vendor's). `reachedLevel` follows the table above; step `ordinal` is the position in the result's step list (checks included).

## Testing

`pnpm --filter @qsr/executor test` runs the unit tests (a fake Docker) and the integration tests against the real daemon: uid, capabilities, memory and pid limits, **host-secret isolation**, path traversal and symlinks, timeouts (including a process that ignores SIGTERM), crash cleanup, the 10 MB flood, the memory bomb and the fork bomb. Without Docker they skip unless `QSR_REQUIRE_DOCKER=1` (set in CI). `QSR_SKIP_DOCKER_TESTS=1` skips them on purpose.
