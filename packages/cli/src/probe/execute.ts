import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { classify, inputFromRunResult } from '@qsr/classifier';
import {
  GUARD_CANARY,
  MANIFEST_FILE,
  Manifest,
  PIPELINE,
  PlanFile,
  RUNNER_ENV_KEYS,
  RunResult,
  TRANSIENT_FAILURE_CLASSES,
  type FailureClass,
  type Logger,
  type Target,
} from '@qsr/core';
import {
  persistRunResult,
  type DockerClient,
  type ExecuteDeps as ExecutorDeps,
  type ExecuteInput,
} from '@qsr/executor';

// `qsr execute` (spec section 12). It runs in the job that has NO secrets, a zero-permission token and no
// route to the API: it reads the plans artifact, runs this shard's tools one after another through the
// executor, and writes results/<slug>-<attempt>.json plus the redacted logs. It never exits non-zero because
// a vendor failed; only a harness crash (no Docker, unreadable plans) is non-zero.
//
// This module must not import the API client or read any API setting: a test pins that.

export class HarnessCrash extends Error {
  override readonly name = 'HarnessCrash';
}

export interface ExecuteOptions {
  plans: string;
  shard: number;
  out: string;
  /** Wait before the single transient retry (spec section 10: 60 s). */
  retryDelayMs?: number;
  /** Added to a tool's expect.timeoutSec to get its watchdog. */
  watchdogMarginMs?: number;
  /** How long a tool gets to stop after the watchdog aborts it, before its container is removed anyway. */
  graceMs?: number;
}

export interface ExecuteDeps {
  docker: DockerClient;
  log: Logger;
  sleep(ms: number): Promise<void>;
  executePlan(input: ExecuteInput, deps: ExecutorDeps): Promise<RunResult>;
  /** The failure class the local rules give a failed run; used only to choose whether to retry. */
  classify(result: RunResult, target: Target, outDir: string): Promise<FailureClass | null>;
  /** Starts the static fixture server (canary docs pages). Only called when a plan refers to it. */
  startFixtures(): Promise<{ close(): Promise<void> }>;
}

export interface ExecuteOutcome {
  /** Tools of this shard that ran (guards excluded). */
  ran: number;
  /** Final attempts of this shard's tools (guards excluded) that ended as a harness error. */
  harnessErrors: number;
}

export const DEFAULT_RETRY_DELAY_MS = PIPELINE.transientRetryDelaySeconds * 1000;
export const DEFAULT_WATCHDOG_MARGIN_MS = 3 * 60_000;
export const DEFAULT_GRACE_MS = 30_000;
const FIXTURE_REFERENCE = '127.0.0.1:';

type ReadyFile = Extract<PlanFile, { state: 'ready' }>;

async function readJson(file: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new HarnessCrash(`${what} (${file}) cannot be read: ${(err as Error).message}`);
  }
}

async function loadPlans(
  options: ExecuteOptions,
): Promise<{ manifest: Manifest; ready: ReadyFile[]; guard: ReadyFile | null }> {
  const manifest = Manifest.safeParse(
    await readJson(path.join(options.plans, MANIFEST_FILE), 'the plan manifest'),
  );
  if (!manifest.success)
    throw new HarnessCrash(`the plan manifest is invalid: ${manifest.error.message}`);
  const m = manifest.data;
  if (!Number.isInteger(options.shard) || options.shard < 0 || options.shard >= m.shards)
    throw new HarnessCrash(
      `shard ${String(options.shard)} does not exist (the plan has ${m.shards})`,
    );

  const files = new Map<string, PlanFile>();
  for (const entry of m.tools) {
    const parsed = PlanFile.safeParse(
      await readJson(
        path.join(options.plans, `${entry.toolSlug}.json`),
        `the plan of ${entry.toolSlug}`,
      ),
    );
    if (!parsed.success)
      throw new HarnessCrash(`the plan of ${entry.toolSlug} is invalid: ${parsed.error.message}`);
    if (parsed.data.cycleId !== m.cycleId || parsed.data.toolSlug !== entry.toolSlug)
      throw new HarnessCrash(`the plan of ${entry.toolSlug} does not belong to this cycle`);
    files.set(entry.toolSlug, parsed.data);
  }

  const ready = [...files.values()].filter(
    (f): f is ReadyFile => f.state === 'ready' && f.shard === options.shard,
  );
  ready.sort(
    (a, b) =>
      (b.weightMs ?? 0) - (a.weightMs ?? 0) ||
      (a.toolSlug < b.toolSlug ? -1 : a.toolSlug > b.toolSlug ? 1 : 0),
  );
  const guardFile = files.get(GUARD_CANARY);
  const guard =
    options.shard > 0 && m.guards.includes(options.shard) && guardFile?.state === 'ready'
      ? guardFile
      : null;
  return { manifest: m, ready, guard };
}

/** The class the local rules assign to a failed run (no model); null for a run that did not FAIL. */
export async function localClassify(
  result: RunResult,
  target: Target,
  outDir: string,
): Promise<FailureClass | null> {
  if (result.outcome !== 'FAIL') return null;
  const logs: Record<string, string> = {};
  for (const step of result.steps) {
    if (!step.logFile) continue;
    try {
      logs[step.stepId] = await readFile(path.resolve(outDir, step.logFile), 'utf8');
    } catch {
      /* the stored tails are used instead */
    }
  }
  const failed = result.steps.find((s) => s.stepId === result.failedStepId);
  const input = inputFromRunResult(result, {
    language: target.language,
    targetLevel: target.level,
    authErrorIsPass: failed?.kind === 'run' && target.expect.authErrorIsPass && target.level >= 3,
    logs,
  });
  return input ? (classify(input)?.failureClass ?? null) : null;
}

const isTransient = (c: FailureClass | null): boolean =>
  c !== null && (TRANSIENT_FAILURE_CLASSES as readonly string[]).includes(c);

function harnessErrorResult(
  file: ReadyFile,
  attempt: number,
  startedAt: Date,
  reason: string,
  partial?: RunResult,
): RunResult {
  return RunResult.parse({
    toolSlug: file.toolSlug,
    cycleId: file.cycleId,
    attempt,
    planId: file.plan.planId,
    snapshotHash: file.plan.snapshotHash,
    outcome: 'HARNESS_ERROR',
    reachedLevel: partial?.reachedLevel ?? 0,
    failedStepId: null,
    steps: partial?.steps ?? [],
    imageDigest: partial?.imageDigest ?? 'unknown',
    runnerEnv: { ...(partial?.runnerEnv ?? {}), harness_error: reason.slice(0, 500) },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  });
}

export async function runExecute(
  options: ExecuteOptions,
  deps: ExecuteDeps,
): Promise<ExecuteOutcome> {
  const { log, docker } = deps;
  const { ready, guard } = await loadPlans(options);

  if ((await docker.serverVersion()) === 'unknown')
    throw new HarnessCrash('Docker is not reachable on this runner');

  const queue: { file: ReadyFile; outDir: string; isGuard: boolean }[] = [
    ...(guard
      ? [
          {
            file: guard,
            outDir: path.join(options.out, 'guards', `shard-${options.shard}`),
            isGuard: true,
          },
        ]
      : []),
    ...ready.map((file) => ({ file, outDir: options.out, isGuard: false })),
  ];

  // Pull the images this shard needs; a failed pull shows up as the tool's own harness error below.
  for (const image of new Set(queue.map((q) => q.file.target.runtime.image))) {
    try {
      await docker.pullImage(image);
    } catch (err) {
      log.warn({ image, err: (err as Error).message }, 'could not pull the sandbox image');
    }
  }

  const needsFixtures = queue.some((q) =>
    JSON.stringify(q.file.plan.ir).includes(FIXTURE_REFERENCE),
  );
  const fixtures = needsFixtures ? await deps.startFixtures() : null;

  const outcome: ExecuteOutcome = { ran: 0, harnessErrors: 0 };
  try {
    for (const item of queue) {
      const final = await runTool(item.file, item.outDir, options, deps);
      if (!item.isGuard) {
        outcome.ran += 1;
        if (final.outcome === 'HARNESS_ERROR') outcome.harnessErrors += 1;
      }
    }
  } finally {
    await fixtures?.close();
  }
  return outcome;
}

async function runTool(
  file: ReadyFile,
  outDir: string,
  options: ExecuteOptions,
  deps: ExecuteDeps,
): Promise<RunResult> {
  const first = await runAttempt(file, 1, outDir, options, deps);
  const watchdogKilled = first.runnerEnv['watchdog'] === 'true';
  if (
    first.outcome === 'FAIL' &&
    !watchdogKilled &&
    isTransient(await deps.classify(first, file.target, outDir))
  ) {
    deps.log.info({ toolSlug: file.toolSlug, attempt: 1 }, 'transient failure; retrying once');
    await deps.sleep(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    return runAttempt(file, 2, outDir, options, deps);
  }
  return first;
}

async function runAttempt(
  file: ReadyFile,
  attempt: number,
  outDir: string,
  options: ExecuteOptions,
  deps: ExecuteDeps,
): Promise<RunResult> {
  const { docker, log } = deps;
  const runId = randomUUID();
  const startedAt = new Date();
  const input: ExecuteInput = {
    target: file.target,
    ir: file.plan.ir,
    image: file.target.runtime.image,
    outDir,
    cycleId: file.cycleId,
    attempt,
    planId: file.plan.planId,
    snapshotHash: file.plan.snapshotHash,
  };
  const controller = new AbortController();
  const watchdogMs =
    file.target.expect.timeoutSec * 1000 + (options.watchdogMarginMs ?? DEFAULT_WATCHDOG_MARGIN_MS);

  type Settled = { kind: 'done'; result: RunResult } | { kind: 'threw'; error: unknown };
  const execution: Promise<Settled> = Promise.resolve()
    .then(() =>
      deps.executePlan(input, {
        docker,
        log,
        signal: controller.signal,
        runId,
        // P9d: the export check runs in SHADOW mode: recorded on the imports-check step, never part of a verdict.
        shadowExportCheck: true,
      }),
    )
    .then(
      (result): Settled => ({ kind: 'done', result }),
      (error: unknown): Settled => ({ kind: 'threw', error }),
    );

  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<'watchdog'>((resolve) => {
    timer = setTimeout(() => resolve('watchdog'), watchdogMs);
  });

  let result: RunResult;
  try {
    const first = await Promise.race([execution, watchdog]);
    if (first === 'watchdog') {
      controller.abort();
      log.error({ runId, toolSlug: file.toolSlug, watchdogMs }, 'watchdog: the tool ran too long');
      let grace: NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        execution,
        new Promise<null>((resolve) => {
          grace = setTimeout(() => resolve(null), options.graceMs ?? DEFAULT_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
      await docker.remove(`qsr-${runId}`).catch((err: unknown) => {
        log.error({ runId, err: (err as Error).message }, 'could not remove the container');
      });
      const partial = settled?.kind === 'done' ? settled.result : undefined;
      result = harnessErrorResult(
        file,
        attempt,
        startedAt,
        `watchdog: no result after ${Math.round(watchdogMs / 1000)} s`,
        partial,
      );
      result.runnerEnv['watchdog'] = 'true';
    } else if (first.kind === 'threw') {
      log.error(
        {
          runId,
          toolSlug: file.toolSlug,
          err: first.error instanceof Error ? first.error.message : String(first.error),
        },
        'the executor crashed',
      );
      await docker.remove(`qsr-${runId}`).catch(() => undefined);
      result = harnessErrorResult(
        file,
        attempt,
        startedAt,
        `executor crash: ${first.error instanceof Error ? first.error.message : String(first.error)}`,
      );
    } else {
      result = first.result;
    }
  } finally {
    clearTimeout(timer);
  }

  result.runnerEnv[RUNNER_ENV_KEYS.shard] = String(options.shard);
  if (file.plan.stale) result.runnerEnv[RUNNER_ENV_KEYS.planStale] = 'true';
  await persistRunResult(outDir, result);
  log.info(
    {
      runId,
      toolSlug: file.toolSlug,
      attempt,
      outcome: result.outcome,
      reachedLevel: result.reachedLevel,
    },
    'tool finished',
  );
  return result;
}
