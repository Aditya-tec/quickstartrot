import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  HARNESS_VERSION,
  noopLogger,
  redact,
  RUNNER_ENV_KEYS,
  RunResult,
  toWorkPath,
  WORK_DIR,
  type Logger,
  type RunOutcome,
  type ShadowExportCheck,
  type ShadowL3,
  type Step,
  type StepIR,
  type StepResult,
  type Target,
} from '@qsr/core';
import {
  DEFAULT_LIMITS,
  type DockerClient,
  type ImageInfo,
  type ResourceLimits,
} from './docker.js';
import {
  CHECK_IDS,
  CHECK_TIMEOUT_S,
  HARNESS_CHECK_KIND,
  planChecks,
  type HarnessCheck,
} from './checks.js';
import { evaluateExpect } from './expect.js';
import { isInstallCommand } from './install.js';
import { clip as clipShadowText, parseShadowOutput } from './shadow.js';
import { shadowL3FromStep, shadowL3Skipped } from './shadow-l3.js';
import { StepOutput } from './sink.js';

export { isInstallCommand };

// Spec section 9. One long-lived, resource-capped container per tool; steps run in order; the first
// failing step stops the run; the container is ALWAYS removed. The executor does not classify
// failures: it records what happened and the classifier (phase P5) decides what it means.
//
// Levels (spec section 6), as this executor proves them:
//   L1  every install step of the plan exited 0
//   L2  L1 + the harness-owned checks passed (the snippet's syntax is valid and every static import
//       resolves; see checks.ts). Writing a file is NOT level 2.
//   L3  L1 + the run step met its Expect (including auth-error-as-pass) AND its output shows evidence that a vendor was reached
//       (an auth pattern, harness v3); no check failed. A run step that passes without that evidence is capped at the level the checks
//       proved, and runner_env.l3 says why.

export interface ExecuteInput {
  target: Pick<
    Target,
    'slug' | 'language' | 'level' | 'placeholders' | 'expect' | 'harness' | 'l3'
  >;
  ir: StepIR;
  /** Image reference to run, e.g. `ghcr.io/owner/qsr-node:22` or one pinned by digest. */
  image: string;
  /** Results directory. Step logs go to `<outDir>/<slug>-<attempt>/NN-<stepId>.log`. */
  outDir: string;
  cycleId: string;
  attempt: number;
  planId: string | null;
  snapshotHash: string | null;
}

export interface ExecuteDeps {
  docker: DockerClient;
  log?: Logger;
  limits?: Partial<ResourceLimits>;
  runId?: string;
  /** Monotonic milliseconds. Injected for tests. */
  clock?: () => number;
  now?: () => Date;
  /** Aborting stops the plan between steps and still removes the container. */
  signal?: AbortSignal | undefined;
  /** Extra values to redact besides placeholder values and set_env values. */
  secrets?: readonly string[];
  /**
   * Also run the experimental export check (qsr-check-exports) after the syntax and imports checks. Off by default and never
   * set by the probe: only `qsr mutate --exports-check` and `qsr run --exports-check` ask for it.
   */
  exportsCheck?: boolean;
  /**
   * Shadow mode (P9d): after every normal step, run the export check and RECORD its answer on the imports-check step. It changes no step
   * outcome, level, failed step or run outcome (shadow.test.ts pins it). `qsr execute` turns it on; nothing may read it back into a verdict.
   */
  shadowExportCheck?: boolean;
}

/** A failure of the harness itself (never the vendor's quickstart): the run outcome is HARNESS_ERROR. */
class HarnessError extends Error {
  override readonly name = 'HarnessError';
}

const SECOND = 1000;
const KILL_GRACE_S = 5; // `timeout -k 5`: SIGKILL this long after SIGTERM
const HOST_SLACK_S = 15; // the host-side deadline sits behind the in-container timeout
const CAPTURE_TIMEOUT_MS = 60 * SECOND;
const CAPTURE_MAX_BYTES = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_FILE = /[^A-Za-z0-9._-]/g;

/** Each step runs as `bash -lc 'exec timeout -k 5 "$1" bash -c "$2"' _ <seconds> <command>`. */
const stepArgv = (seconds: number, command: string): string[] => [
  'bash',
  '-lc',
  `exec timeout -k ${KILL_GRACE_S} "$1" bash -c "$2"`,
  '_',
  String(seconds),
  command,
];

/**
 * Writes stdin to a path after resolving symlinks INSIDE the container and refusing anything that
 * resolves outside /work (exit 97). `docker cp` is not used: it creates root-owned files that the
 * unprivileged runner can then neither append to nor rewrite.
 */
const WRITE_SCRIPT = [
  'set -eu',
  't=$(realpath -m -- "$1")',
  'case "$t" in /work/*) ;; *) echo "qsr: path resolves outside /work: $t" >&2; exit 97;; esac',
  'mkdir -p -- "$(dirname -- "$t")"',
  'if [ "$2" = append ]; then cat >> "$t"; else cat > "$t"; fi',
].join('\n');

const ENV_FILE_SCRIPT = 'cat >> "$HOME/.qsr_env"';

const CAPTURE_ENV_SCRIPT: Record<Target['language'], string> = {
  node: [
    'echo "node=$(node --version)"',
    'echo "npm=$(npm --version)"',
    'echo "registry=$(npm config get registry)"',
    'echo "os=$(. /etc/os-release; echo "$PRETTY_NAME")"',
  ].join('; '),
  python: [
    'echo "python=$(python --version 2>&1)"',
    'echo "pip=$(pip --version | cut -d\' \' -f2)"',
    'echo "registry=$(pip config get global.index-url 2>/dev/null || echo https://pypi.org/simple)"',
    'echo "os=$(. /etc/os-release; echo "$PRETTY_NAME")"',
  ].join('; '),
};
const CAPTURE_RESOLVED_SCRIPT: Record<Target['language'], string> = {
  node: 'npm ls --depth=0 --json 2>/dev/null || true',
  python: 'pip freeze 2>/dev/null || true',
};
const ENV_KEYS = new Set(['node', 'npm', 'python', 'pip', 'registry', 'os']);

const ESM =
  /^\s*(?:import\s+(?:[\w*{][^\n]*?\s+from\s+)?['"]|export\s+(?:default|const|let|var|function|class|async|\{|\*))/m;

/** A reference whose first path segment is a registry host: `ghcr.io/o/i:22`, `localhost:5000/i`. */
const REGISTRY_REF = /^(?:[^/@]+[.:][^/@]*|localhost)\//;

export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

const PROOF_KINDS = new Set(['shell', 'run', 'write_file', 'append_file', HARNESS_CHECK_KIND]);

/**
 * Level reached = the highest level the passed steps prove (spec section 6). `installIds` are the
 * plan's install steps: L1 needs every one of them to have passed. A plan with no install step is
 * level 1 as soon as anything ran.
 */
export function reachedLevel(
  steps: readonly StepResult[],
  installIds: ReadonlySet<string> = new Set(),
): number {
  const passed = steps.filter((s) => s.outcome === 'PASS');
  const passedIds = new Set(passed.map((s) => s.stepId));
  const l1 =
    installIds.size > 0
      ? [...installIds].every((id) => passedIds.has(id))
      : passed.some((s) => PROOF_KINDS.has(s.kind));
  if (!l1) return 0;
  const checks = steps.filter((s) => s.kind === HARNESS_CHECK_KIND);
  if (checks.some((s) => s.outcome !== 'PASS')) return 1;
  if (passed.some((s) => s.kind === 'run' && s.matchedAuthPattern !== null)) return 3;
  return checks.length > 0 ? 2 : 1;
}

/** The digest recorded on the run: pinned in the reference, else the registry digest, else the local image id. */
export function pickDigest(
  image: string,
  info: ImageInfo,
): { digest: string; source: 'registry' | 'local' } {
  const pinned = /@(sha256:[0-9a-f]{64})$/.exec(image);
  if (pinned) return { digest: pinned[1] as string, source: 'registry' };
  const fromRegistry = info.repoDigests
    .map((d) => /@(sha256:[0-9a-f]{64})$/.exec(d)?.[1])
    .find(Boolean);
  // Whether an image came from a registry is decided by its reference, not by the presence of a repo
  // digest: Docker Desktop's image store invents one for locally built images.
  if (!REGISTRY_REF.test(image)) return { digest: info.id, source: 'local' };
  return { digest: fromRegistry ?? info.id, source: 'registry' };
}

function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    const key = line.slice(0, eq);
    if (eq > 0 && ENV_KEYS.has(key))
      out[key] = line
        .slice(eq + 1)
        .trim()
        .slice(0, 200);
  }
  return out;
}

function parseResolvedOutput(language: Target['language'], text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (language === 'node') {
    try {
      const parsed: unknown = JSON.parse(text);
      const deps =
        (parsed as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {};
      for (const [name, info] of Object.entries(deps))
        if (typeof info?.version === 'string') out[name] = info.version;
    } catch {
      /* not JSON: nothing resolved */
    }
    return out;
  }
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_.-]+)\s*(?:==\s*(\S+)|@\s*(\S+))\s*$/.exec(line.trim());
    if (m) out[m[1] as string] = (m[2] ?? m[3]) as string;
  }
  return out;
}

const usesEsmInJs = (steps: readonly Step[]): boolean =>
  steps.some((s) => s.kind === 'write_file' && /\.jsx?$/.test(s.path) && ESM.test(s.content));
const writesPackageJson = (steps: readonly Step[]): boolean =>
  steps.some((s) => s.kind === 'write_file' && s.path.replace(/^\.\//, '') === 'package.json');

export async function executePlan(input: ExecuteInput, deps: ExecuteDeps): Promise<RunResult> {
  const { docker, signal } = deps;
  const { target, ir } = input;
  const log = deps.log ?? noopLogger;
  const clock = deps.clock ?? (() => performance.now());
  const now = deps.now ?? (() => new Date());
  const runId = deps.runId ?? randomUUID();
  const name = `qsr-${runId}`;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const logFields = { runId, toolSlug: target.slug };

  const startedAt = now();
  const t0 = clock();
  const budgetMs = target.expect.timeoutSec * SECOND;
  const stepDir = `${target.slug}-${input.attempt}`;
  const secrets = [
    ...Object.values(target.placeholders),
    ...ir.steps.flatMap((s) => (s.kind === 'set_env' ? [s.value] : [])),
    ...(deps.secrets ?? []),
  ];

  const steps: StepResult[] = [];
  const runnerEnv: Record<string, string> = { hostPlatform: process.platform };
  let imageDigest = 'unknown';
  let outcome: RunOutcome = 'PASS';
  let failedStepId: string | null = null;
  let containerStarted = false;
  let current: { id: string; kind: string; ordinal: number } | null = null;
  let resolvedCaptured = false;

  /** Runs a quiet helper command and returns its stdout (bounded, redacted). */
  const capture = async (argv: string[]): Promise<{ exitCode: number | null; stdout: string }> => {
    let stdout = '';
    const result = await docker.exec(name, argv, {
      timeoutMs: CAPTURE_TIMEOUT_MS,
      signal,
      onStdout: (c) => {
        if (stdout.length < CAPTURE_MAX_BYTES) stdout += c.toString('utf8');
      },
      onStderr: () => undefined,
    });
    return { exitCode: result.exitCode, stdout: redact(stdout, { secrets }) };
  };

  const captureResolved = async (): Promise<void> => {
    resolvedCaptured = true;
    const { stdout } = await capture(['bash', '-lc', CAPTURE_RESOLVED_SCRIPT[target.language]]);
    runnerEnv[RUNNER_ENV_KEYS.resolved] = JSON.stringify(
      parseResolvedOutput(target.language, stdout),
    );
  };

  /** Runs one harness command (project setup); a failure here is ours, not the vendor's. */
  const harnessCommand = async (script: string): Promise<void> => {
    const r = await capture(['bash', '-lc', script]);
    if (r.exitCode !== 0)
      throw new HarnessError(
        `setup command "${script}" failed (exit ${r.exitCode}): ${r.stdout.trim()}`,
      );
  };

  const writeStepLog = async (ordinal: number, stepId: string, text: string): Promise<string> => {
    const rel = path.posix.join(
      stepDir,
      `${String(ordinal).padStart(2, '0')}-${stepId.replace(SAFE_FILE, '_')}.log`,
    );
    await mkdir(path.join(input.outDir, stepDir), { recursive: true });
    await writeFile(path.join(input.outDir, rel), text);
    return rel;
  };

  const result = (
    step: { id: string; kind: string },
    ordinal: number,
    r: Partial<StepResult> & Pick<StepResult, 'outcome'>,
  ): StepResult => ({
    stepId: step.id,
    ordinal,
    kind: step.kind,
    exitCode: null,
    durationMs: 0,
    stdoutTail: null,
    stderrTail: null,
    logFile: null,
    matchedAuthPattern: null,
    skipReason: null,
    shadowExportCheck: null,
    ...r,
  });

  /** Executes a shell or run step and decides pass or fail from the evidence. */
  const runCommand = async (
    step: Extract<Step, { kind: 'shell' | 'run' }>,
    ordinal: number,
  ): Promise<StepResult> => {
    const out = new StepOutput({ secrets, stdoutIncludes: step.expect.stdoutIncludes });
    const remainingMs = budgetMs - (clock() - t0);
    if (remainingMs <= 0) {
      out.note(
        `[qsr] the run exceeded its overall time limit of ${target.expect.timeoutSec}s before this step started`,
      );
      const o = out.finish();
      const logFile = await writeStepLog(ordinal, step.id, o.log);
      return result(step, ordinal, {
        outcome: 'FAIL',
        exitCode: 124,
        stdoutTail: o.stdoutTail,
        stderrTail: o.stderrTail,
        logFile,
      });
    }
    const seconds = Math.max(1, Math.min(step.expect.timeoutSec, Math.floor(remainingMs / SECOND)));

    const began = clock();
    const exec = await docker.exec(name, stepArgv(seconds, step.command), {
      timeoutMs: (seconds + KILL_GRACE_S + HOST_SLACK_S) * SECOND,
      signal,
      onStdout: (c) => out.stdout(c),
      onStderr: (c) => out.stderr(c),
    });
    const durationMs = Math.round(clock() - began);

    const timedOut =
      exec.timedOut ||
      exec.exitCode === 124 ||
      (exec.exitCode === 137 && durationMs >= seconds * SECOND - 500);
    if (timedOut) {
      out.note(`[qsr] step timed out after ${seconds}s and was killed`);
    } else if (exec.exitCode === 137) {
      out.note(
        `[qsr] the process was killed with SIGKILL (exit 137): most likely it exceeded the container memory limit of ${limits.memory}`,
      );
    }

    const verdict = evaluateExpect(step.expect, {
      exitCode: exec.exitCode,
      timedOut,
      ...out.currentEvidence(),
    });
    // Only auth-error decisions get a log line: they are the one case where the exit code alone would mislead.
    if (verdict.matchedAuthPattern !== null) out.note(`[qsr] ${verdict.reason}`);
    const o = out.finish();
    // `docker exec` itself exits 125 when the daemon rejects the request (container gone, daemon
    // down). That is the harness failing, not the quickstart.
    if (exec.exitCode === 125 && /Error response from daemon/.test(o.stderrTail)) {
      throw new HarnessError(`docker exec failed: ${o.stderrTail.trim()}`);
    }
    const logFile = await writeStepLog(ordinal, step.id, o.log);
    return result(step, ordinal, {
      outcome: verdict.pass ? 'PASS' : 'FAIL',
      exitCode: exec.exitCode,
      durationMs,
      stdoutTail: o.stdoutTail,
      stderrTail: o.stderrTail,
      logFile,
      matchedAuthPattern: verdict.matchedAuthPattern,
    });
  };

  const runWrite = async (
    step: Extract<Step, { kind: 'write_file' | 'append_file' }>,
    ordinal: number,
  ): Promise<StepResult> => {
    const p = toWorkPath(step.path);
    if (!p.ok)
      throw new HarnessError(
        `path ${JSON.stringify(step.path)} is not allowed for ${step.kind}: ${p.reason}`,
      );
    const absolute = `${WORK_DIR}/${p.path}`;
    const content = step.content.endsWith('\n') ? step.content : `${step.content}\n`;
    const began = clock();
    let stderr = '';
    const exec = await docker.exec(
      name,
      ['bash', '-c', WRITE_SCRIPT, '_', absolute, step.kind === 'append_file' ? 'append' : 'write'],
      {
        stdin: content,
        timeoutMs: CAPTURE_TIMEOUT_MS,
        signal,
        onStdout: () => undefined,
        onStderr: (c) => {
          stderr += c.toString('utf8');
        },
      },
    );
    if (exec.exitCode !== 0)
      throw new HarnessError(
        `writing ${absolute} failed (exit ${exec.exitCode}): ${stderr.trim()}`,
      );
    return result(step, ordinal, {
      outcome: 'PASS',
      exitCode: 0,
      durationMs: Math.round(clock() - began),
    });
  };

  const runSetEnv = async (
    step: Extract<Step, { kind: 'set_env' }>,
    ordinal: number,
  ): Promise<StepResult> => {
    if (!ENV_NAME.test(step.name))
      throw new HarnessError(
        `environment variable name ${JSON.stringify(step.name)} is not a plain identifier`,
      );
    const exec = await docker.exec(name, ['bash', '-c', ENV_FILE_SCRIPT], {
      stdin: `export ${step.name}=${shellQuote(step.value)}\n`,
      timeoutMs: CAPTURE_TIMEOUT_MS,
      signal,
      onStdout: () => undefined,
      onStderr: () => undefined,
    });
    if (exec.exitCode !== 0)
      throw new HarnessError(`could not write the environment file (exit ${exec.exitCode})`);
    return result(step, ordinal, { outcome: 'PASS', exitCode: 0 });
  };

  /**
   * Runs one harness-owned check. Exit 0 passes and exit 1 is a finding in the docs' code; anything
   * else means the check itself could not run, which is the harness failing, not the docs.
   */
  const runHarnessCheck = async (check: HarnessCheck): Promise<StepResult> => {
    const ordinal = steps.length;
    current = { id: check.id, kind: HARNESS_CHECK_KIND, ordinal };
    const out = new StepOutput({ secrets, stdoutIncludes: [] });
    const began = clock();
    const exec = await docker.exec(name, check.argv, {
      stdin: check.stdin,
      timeoutMs: (CHECK_TIMEOUT_S + KILL_GRACE_S + HOST_SLACK_S) * SECOND,
      signal,
      onStdout: (c) => out.stdout(c),
      onStderr: (c) => out.stderr(c),
    });
    const durationMs = Math.round(clock() - began);
    const o = out.finish();
    if (exec.exitCode !== 0 && exec.exitCode !== 1)
      throw new HarnessError(
        `harness check ${check.id} could not run (exit ${exec.exitCode}): ${o.stderrTail.trim() || o.stdoutTail.trim()}`,
      );
    const logFile = await writeStepLog(ordinal, check.id, o.log);
    current = null;
    return result({ id: check.id, kind: HARNESS_CHECK_KIND }, ordinal, {
      outcome: exec.exitCode === 0 ? 'PASS' : 'FAIL',
      exitCode: exec.exitCode,
      durationMs,
      stdoutTail: o.stdoutTail,
      stderrTail: o.stderrTail,
      logFile,
    });
  };

  /**
   * Shadow mode. Runs last, after every plan step and normal check has finished, so nothing it does can reach a step. Whatever
   * happens (a fail, a crash, a timeout, plumbing that throws) is written to the shadow field of the imports-check step and nowhere
   * else: it never throws out of here and never touches outcome, failedStepId or any other step.
   */
  const recordShadowExportCheck = async (): Promise<void> => {
    const at = steps.findIndex((s) => s.stepId === CHECK_IDS.imports);
    if (at < 0) return;
    // Every record is clipped to what the schema allows: an over-long note (an opt-out reason at its limit plus the prefix did this in
    // production) must never fail the validation of the whole result, which would turn a recording into a HARNESS_ERROR.
    const write = (record: ShadowExportCheck): void => {
      const safe: ShadowExportCheck = {
        ...record,
        missing: record.missing.slice(0, 50).map((m) => clipShadowText(m, 200)),
        note: record.note === null ? null : clipShadowText(record.note, 300),
      };
      steps[at] = { ...(steps[at] as StepResult), shadowExportCheck: safe };
    };
    const optOut = target.harness;
    if (optOut?.skipExportCheck === true) {
      write({
        outcome: 'skipped',
        missing: [],
        note: `skipExportCheck: ${optOut.reason}`,
        durationMs: 0,
      });
      return;
    }
    const check = planChecks(ir, { exports: true })?.checks.find((c) => c.id === CHECK_IDS.exports);
    if (!check) return;
    const out = new StepOutput({ secrets, stdoutIncludes: [] });
    const began = clock();
    try {
      const exec = await docker.exec(name, check.argv, {
        stdin: check.stdin,
        timeoutMs: (CHECK_TIMEOUT_S + KILL_GRACE_S + HOST_SLACK_S) * SECOND,
        signal,
        onStdout: (c) => out.stdout(c),
        onStderr: (c) => out.stderr(c),
      });
      const o = out.finish();
      write(
        parseShadowOutput({
          exitCode: exec.exitCode,
          timedOut: exec.timedOut,
          stdout: o.stdoutTail,
          stderr: o.stderrTail,
          durationMs: Math.round(clock() - began),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write({
        outcome: 'skipped',
        missing: [],
        note: redact(`the check could not run: ${message}`, { secrets }).slice(0, 300),
        durationMs: Math.round(clock() - began),
      });
    }
  };

  const shadowL3 = target.l3?.mode === 'shadow';
  let deferredRun: Extract<Step, { kind: 'run' }> | null = null;

  /**
   * Shadow-L3. Runs the held-back run step ONCE, after every normal step and check, and writes what it said on the LAST step as
   * shadowL3. Whatever happens (evidence or none, a failure, a timeout, plumbing that throws) is recorded there and nowhere else: it never
   * throws out of here and never touches the outcome, the failed step, the level or any other step. At most one vendor request per run.
   */
  const recordShadowL3 = async (step: Extract<Step, { kind: 'run' }>): Promise<void> => {
    const at = steps.length - 1;
    if (at < 0) return;
    const write = (record: ShadowL3): void => {
      const safe: ShadowL3 = {
        ...record,
        observed: record.observed === null ? null : clipShadowText(record.observed, 300),
        note: record.note === null ? null : clipShadowText(record.note, 300),
      };
      steps[at] = { ...(steps[at] as StepResult), shadowL3: safe };
    };
    const began = clock();
    try {
      write(shadowL3FromStep(await runCommand(step, steps.length)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write(
        shadowL3Skipped(
          redact(`the step could not run: ${message}`, { secrets }),
          Math.round(clock() - began),
        ),
      );
    }
  };

  const installIds = new Set(
    ir.steps.flatMap((s) => (s.kind === 'shell' && isInstallCommand(s.command) ? [s.id] : [])),
  );
  // A target that opted out (harness.skipExportCheck, with a reason) never gets the export check, in shadow mode or as the experiment.
  const checkPlan = planChecks(ir, {
    exports: deps.exportsCheck === true && target.harness?.skipExportCheck !== true,
  });
  const lastInstall = ir.steps.reduce(
    (last, s, i) => (s.kind === 'shell' && isInstallCommand(s.command) ? i : last),
    -1,
  );

  try {
    let info = await docker.inspectImage(input.image);
    if (info === null) {
      log.info({ ...logFields, image: input.image }, 'pulling image');
      await docker.pullImage(input.image);
      info = await docker.inspectImage(input.image);
    }
    if (info === null)
      throw new HarnessError(`image ${input.image} is not available after pulling`);
    const picked = pickDigest(input.image, info);
    imageDigest = picked.digest;
    Object.assign(runnerEnv, {
      imageRef: input.image,
      imageDigest: picked.digest,
      imageSource: picked.source,
      dockerServer: await docker.serverVersion(),
      memoryLimit: limits.memory,
      cpus: limits.cpus,
    });

    containerStarted = true;
    await docker.start({ name, image: input.image, limits, labels: { 'qsr.run-id': runId } });
    log.info({ ...logFields, container: name, imageDigest }, 'container started');

    const env = await capture(['bash', '-lc', CAPTURE_ENV_SCRIPT[target.language]]);
    if (env.exitCode === 0) Object.assign(runnerEnv, parseEnvLines(env.stdout));

    if (ir.projectInit === 'npm_init') {
      await harnessCommand('npm init -y');
      if (usesEsmInJs(ir.steps) && !writesPackageJson(ir.steps))
        await harnessCommand('npm pkg set type=module');
    }

    for (const [index, step] of ir.steps.entries()) {
      // Shadow-L3: the L3 step is not part of the run. It is held back and run once, last, by recordShadowL3 (zero effect on the run).
      if (shadowL3 && step.kind === 'run') {
        deferredRun ??= step;
        continue;
      }
      const ordinal = steps.length;
      current = { id: step.id, kind: step.kind, ordinal };
      if (signal?.aborted) throw new HarnessError('aborted');

      let r: StepResult;
      if (step.kind === 'shell' || step.kind === 'run') r = await runCommand(step, ordinal);
      else if (step.kind === 'write_file' || step.kind === 'append_file')
        r = await runWrite(step, ordinal);
      else if (step.kind === 'set_env') r = await runSetEnv(step, ordinal);
      else r = result(step, ordinal, { outcome: 'SKIPPED', skipReason: 'manual_step' }); // a person must act
      current = null;
      steps.push(r);
      log.info(
        {
          ...logFields,
          stepId: step.id,
          kind: step.kind,
          outcome: r.outcome,
          exitCode: r.exitCode,
        },
        'step done',
      );

      if (index === lastInstall) await captureResolved();
      if (step.kind === 'manual') {
        if (reachedLevel(steps, installIds) < target.level) {
          outcome = 'SKIPPED';
          failedStepId = step.id;
        }
        break;
      }
      if (r.outcome === 'FAIL') {
        outcome = 'FAIL';
        failedStepId = step.id;
        break;
      }
      if (checkPlan !== null && index === checkPlan.afterIndex) {
        for (const check of checkPlan.checks) {
          const c = await runHarnessCheck(check);
          steps.push(c);
          log.info(
            {
              ...logFields,
              stepId: check.id,
              kind: c.kind,
              outcome: c.outcome,
              exitCode: c.exitCode,
            },
            'step done',
          );
          if (c.outcome === 'FAIL') {
            outcome = 'FAIL';
            failedStepId = check.id;
            break;
          }
        }
        if (outcome === 'FAIL') break;
      }
    }
    if (
      deps.shadowExportCheck === true &&
      deps.exportsCheck !== true &&
      outcome === 'PASS' &&
      checkPlan !== null
    )
      await recordShadowExportCheck();
    if (shadowL3 && deferredRun !== null && outcome === 'PASS') await recordShadowL3(deferredRun);
    if (!resolvedCaptured) await captureResolved();
  } catch (err) {
    outcome = 'HARNESS_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    log.error({ ...logFields, err: message }, 'harness error');
    if (current !== null) {
      failedStepId = current.id;
      steps.push(
        result(current, current.ordinal, {
          outcome: 'FAIL',
          stderrTail: redact(`harness error: ${message}\n`, { secrets }).slice(0, 4096),
        }),
      );
    }
    // A failure outside any step (image, container start, setup) has no step to attach to.
  } finally {
    if (containerStarted) {
      try {
        await docker.remove(name);
      } catch (err) {
        log.warn(
          { ...logFields, container: name, err: err instanceof Error ? err.message : String(err) },
          'could not remove container',
        );
      }
    }
  }

  const level = reachedLevel(steps, installIds);
  // A run step passed but L3 was not claimed: say why (never a failure; the status engine does not read it).
  if (level < 3 && steps.some((s) => s.kind === 'run' && s.outcome === 'PASS'))
    runnerEnv[RUNNER_ENV_KEYS.l3] = target.expect.localOnly === true ? 'local' : 'no_evidence';

  return RunResult.parse({
    toolSlug: target.slug,
    cycleId: input.cycleId,
    attempt: input.attempt,
    planId: input.planId,
    snapshotHash: input.snapshotHash,
    harnessVersion: HARNESS_VERSION,
    outcome,
    reachedLevel: level,
    failedStepId,
    steps,
    imageDigest,
    runnerEnv,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
  });
}

/** Writes `<outDir>/<slug>-<attempt>.json`: the data the report job reads (spec section 9, output contract). */
export async function persistRunResult(outDir: string, result: RunResult): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${result.toolSlug}-${result.attempt}.json`);
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}
