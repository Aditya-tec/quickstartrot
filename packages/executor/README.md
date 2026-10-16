# @qsr/executor

Runs a compiled Step IR plan inside one resource-capped Docker container per tool and returns a `RunResult` (spec section 9). It records what happened; it **never classifies** failures (that is phase P5) and never talks to the network itself: the Docker daemon does, on behalf of the container.

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
   - `manual`: the step is `SKIPPED` and the plan stops. The run is a `FAIL` if the target level was not reached yet.
5. After the last install step it captures the resolved top-level dependencies (`npm ls --depth=0 --json` / `pip freeze`) into `runnerEnv.resolved`.
6. `docker rm -f` in a `finally` block, always: on success, failure, timeout, crash and abort.

### Evaluating a step (`expect.ts`)

Exit code, `stdoutIncludes`, and auth-error-as-pass exactly as in the spec: with `authErrorIsPass`, a non-zero exit passes only if the output matches an auth pattern (`HTTP 401/403`, `unauthorized`, `invalid api key`, `invalid_api_key`, `authentication failed`, `missing api key`, `forbidden`) **and** no drift pattern (`is not a function`, `Cannot find module`, `ModuleNotFoundError`, `ImportError`, `AttributeError`, `SyntaxError`). The matched pattern is stored on the step result. 100% coverage is enforced.

### Output (`sink.ts`)

Line by line, redacted before anything is stored (`redact` in `@qsr/core`): dummy keys, secret-looking tokens, the home path, IPs, ANSI. At most 256 KB of log per step goes to a file; the last 4 KB of each stream is kept as `stdoutTail` / `stderrTail`; one over-long line is cut instead of buffered.

### Outcomes

`PASS`, `FAIL` (a step failed, or a manual step stopped the plan before the target level), `HARNESS_ERROR` (Docker, a bad path, an executor exception: ours, never the vendor's). `reachedLevel` is derived from the steps that passed: a passed `run` is L3, a written file L2, a passed install L1.

## Testing

`pnpm --filter @qsr/executor test` runs the unit tests (a fake Docker) and the integration tests against the real daemon: uid, capabilities, memory and pid limits, **host-secret isolation**, path traversal and symlinks, timeouts (including a process that ignores SIGTERM), crash cleanup, the 10 MB flood, the memory bomb and the fork bomb. Without Docker they skip unless `QSR_REQUIRE_DOCKER=1` (set in CI). `QSR_SKIP_DOCKER_TESTS=1` skips them on purpose.
