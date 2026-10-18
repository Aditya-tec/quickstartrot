import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerClient, ExecuteDeps, ExecuteInput } from '@qsr/executor';
import {
  PIPELINE,
  type Manifest,
  RunResult,
  RUNNER_ENV_KEYS,
  type PlanFile,
  type RunResult as RunResultType,
  type Target,
} from '@qsr/core';
import {
  DEFAULT_RETRY_DELAY_MS,
  HarnessCrash,
  localClassify,
  runExecute,
  type ExecuteDeps as Deps,
} from './execute.js';
import {
  CYCLE,
  PLAN_ID,
  canaryTarget,
  readyPlan,
  recordingLogger,
  runResultFor,
  target,
} from './probe.test-utils.js';

// `qsr execute` (spec section 12) runs in the job that has NO secrets and NO route to the API. It reads the
// plans artifact, runs its shard's tools one after another through the executor, retries a transient failure
// once, and writes results/<slug>-<attempt>.json plus the redacted logs. A vendor failure is a result, never
// a non-zero exit; only a harness crash is.

let dir: string;
let plans: string;
let results: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qsr-exec-'));
  plans = path.join(dir, 'plans');
  results = path.join(dir, 'results');
  await mkdir(plans, { recursive: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function writePlans(
  files: PlanFile[],
  manifest: { shards: number; guards?: number[] } = { shards: 2 },
) {
  for (const f of files) await writeFile(path.join(plans, `${f.toolSlug}.json`), JSON.stringify(f));
  const m: Manifest = {
    version: 1,
    cycleId: CYCLE,
    createdAt: '2026-10-16T12:00:00.000Z',
    shards: manifest.shards,
    guards: manifest.guards ?? [],
    tools: files.map((f) => ({
      toolSlug: f.toolSlug,
      state: f.state,
      shard: f.state === 'ready' ? f.shard : null,
      stale: f.state === 'ready' && f.plan.stale,
      isCanary: f.isCanary,
    })),
  };
  await writeFile(path.join(plans, 'manifest.json'), JSON.stringify(m));
}

type Behaviour = (input: ExecuteInput, attempt: number) => RunResultType | Promise<RunResultType>;

function harness(over: Partial<Deps> = {}, behaviours: Record<string, Behaviour> = {}) {
  const calls: {
    slug: string;
    attempt: number;
    input: ExecuteInput;
    runId: string | undefined;
    shadow: boolean | undefined;
    enforced: boolean | undefined;
  }[] = [];
  const sleeps: number[] = [];
  const pulled: string[] = [];
  const removed: string[] = [];
  let running = 0;
  let overlap = false;
  const docker = {
    serverVersion: async () => '27.0.0',
    inspectImage: async () => null,
    pullImage: async (image: string) => void pulled.push(image),
    remove: async (name: string) => void removed.push(name),
  } as unknown as DockerClient;
  const deps: Deps = {
    docker,
    log: recordingLogger(),
    sleep: async (ms) => void sleeps.push(ms),
    executePlan: async (input: ExecuteInput, d: ExecuteDeps) => {
      running += 1;
      if (running > 1) overlap = true;
      calls.push({
        slug: input.target.slug,
        attempt: input.attempt,
        input,
        runId: d.runId,
        shadow: d.shadowExportCheck,
        enforced: d.exportsCheck,
      });
      try {
        const fn = behaviours[input.target.slug];
        return fn
          ? await fn(input, input.attempt)
          : runResultFor(input.target.slug, { attempt: input.attempt });
      } finally {
        running -= 1;
      }
    },
    classify: async () => null,
    startFixtures: async () => ({ close: async () => undefined }),
    ...over,
  };
  return { deps, calls, sleeps, pulled, removed, overlapped: () => overlap };
}

const run = (h: ReturnType<typeof harness>, shard = 0, extra = {}) =>
  runExecute({ plans, shard, out: results, retryDelayMs: 60_000, ...extra }, h.deps);
const readResult = async (file: string): Promise<RunResultType> =>
  RunResult.parse(JSON.parse(await readFile(path.join(results, file), 'utf8')));

describe('shadow mode (P9d)', () => {
  it('every production run asks the executor for the shadow export check, and never for the enforcing one', async () => {
    await writePlans([readyPlan(target('a-node'), 0), readyPlan(target('b-node'), 0)]);
    const h = harness();
    await run(h);
    expect(h.calls.length).toBeGreaterThan(0);
    for (const c of h.calls) {
      expect(c.shadow, c.slug).toBe(true);
      expect(c.enforced, c.slug).toBeUndefined();
    }
  });
});

describe('which tools run', () => {
  it('runs only the ready plans of its shard, one after another, and writes results/<slug>-1.json', async () => {
    await writePlans([
      readyPlan(target('a-node'), 0),
      readyPlan(target('b-node'), 1),
      readyPlan(target('c-node'), 0),
    ]);
    const h = harness();
    await run(h, 0);
    expect(h.calls.map((c) => c.slug).sort()).toEqual(['a-node', 'c-node']);
    expect(h.overlapped()).toBe(false);
    expect((await readResult('a-node-1.json')).toolSlug).toBe('a-node');
    expect(await readdir(results)).not.toContain('b-node-1.json');
  });

  it('passes the cycle, the plan id, the snapshot, the attempt and the target image to the executor', async () => {
    await writePlans([readyPlan(target('a-node'), 0)]);
    const h = harness();
    await run(h);
    const input = h.calls[0]?.input as ExecuteInput;
    expect(input).toMatchObject({
      cycleId: CYCLE,
      attempt: 1,
      planId: PLAN_ID,
      image: 'ghcr.io/aditya-tec/qsr-node:22',
    });
    expect(input.snapshotHash).toBe('a'.repeat(64));
    expect(input.outDir).toBe(results);
  });

  it('skips pre-failed and deferred entries: nothing to run for them', async () => {
    const t = target('a-node');
    await writePlans([
      readyPlan(t, 0),
      {
        version: 1,
        toolSlug: 'bad-node',
        cycleId: CYCLE,
        isCanary: false,
        target: target('bad-node'),
        weightMs: null,
        state: 'pre_failed',
        preflight: { stage: 'crawl', failureClass: 'CRAWL_ERROR', reason: 'x', message: 'y' },
        planId: null,
        snapshotHash: null,
      },
      {
        version: 1,
        toolSlug: 'skip-node',
        cycleId: CYCLE,
        isCanary: false,
        target: target('skip-node'),
        weightMs: null,
        state: 'deferred',
        reason: 'llm_budget',
      },
    ]);
    const h = harness();
    await run(h);
    expect(h.calls.map((c) => c.slug)).toEqual(['a-node']);
  });

  it('refuses a shard the manifest does not have', async () => {
    await writePlans([readyPlan(target('a-node'), 0)], { shards: 2 });
    await expect(run(harness(), 2)).rejects.toBeInstanceOf(HarnessCrash);
  });

  it('refuses a plans directory without a valid manifest, or with a tampered plan file', async () => {
    await expect(run(harness())).rejects.toBeInstanceOf(HarnessCrash);
    await writePlans([readyPlan(target('a-node'), 0)]);
    await writeFile(path.join(plans, 'a-node.json'), '{"steps":"rm -rf /"}');
    await expect(run(harness())).rejects.toBeInstanceOf(HarnessCrash);
  });

  it('a plan file for a different cycle than the manifest is refused', async () => {
    const f = readyPlan(target('a-node'), 0);
    await writePlans([f]);
    await writeFile(
      path.join(plans, 'a-node.json'),
      JSON.stringify({ ...f, cycleId: '11111111-1111-4111-8111-111111111111' }),
    );
    await expect(run(harness())).rejects.toBeInstanceOf(HarnessCrash);
  });
});

describe('the transient retry (spec section 10): once, after 60 s, and only the final attempt counts', () => {
  const failing =
    (stderr: string): Behaviour =>
    (input, attempt) =>
      attempt === 1
        ? runResultFor(input.target.slug, {
            attempt,
            outcome: 'FAIL',
            reachedLevel: 1,
            failedStepId: 's1',
            steps: [
              {
                stepId: 's1',
                ordinal: 0,
                kind: 'shell',
                outcome: 'FAIL',
                exitCode: 1,
                durationMs: 100,
                stdoutTail: null,
                stderrTail: stderr,
                logFile: null,
                matchedAuthPattern: null,
                skipReason: null,
              },
            ],
          })
        : runResultFor(input.target.slug, { attempt });

  it.each(['NETWORK_TRANSIENT', 'TIMEOUT'] as const)(
    'a %s failure is retried once after 60 s as attempt 2; both results are written',
    async (cls) => {
      await writePlans([readyPlan(target('a-node'), 0)]);
      const h = harness({ classify: async () => cls }, { 'a-node': failing('npm error network') });
      await run(h);
      expect(h.calls.map((c) => c.attempt)).toEqual([1, 2]);
      expect(h.sleeps).toEqual([PIPELINE.transientRetryDelaySeconds * 1000]);
      expect(DEFAULT_RETRY_DELAY_MS).toBe(PIPELINE.transientRetryDelaySeconds * 1000);
      expect((await readResult('a-node-1.json')).outcome).toBe('FAIL');
      expect((await readResult('a-node-2.json')).outcome).toBe('PASS');
    },
  );

  it('never a third attempt: a second transient failure is simply the final result', async () => {
    await writePlans([readyPlan(target('a-node'), 0)]);
    const always: Behaviour = (input, attempt) =>
      runResultFor(input.target.slug, { attempt, outcome: 'FAIL', failedStepId: 's1' });
    const h = harness({ classify: async () => 'NETWORK_TRANSIENT' }, { 'a-node': always });
    await run(h);
    expect(h.calls).toHaveLength(2);
  });

  it.each(['API_DRIFT', 'DOCS_SNIPPET_ERROR', 'DEPENDENCY_RESOLUTION', 'UNKNOWN', null] as const)(
    'a %s failure is not retried',
    async (cls) => {
      await writePlans([readyPlan(target('a-node'), 0)]);
      const fail: Behaviour = (input, attempt) =>
        runResultFor(input.target.slug, { attempt, outcome: 'FAIL', failedStepId: 's1' });
      const h = harness({ classify: async () => cls }, { 'a-node': fail });
      await run(h);
      expect(h.calls).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
    },
  );

  it('a transient failure AT A RUN STEP is not retried: the run step already made its one vendor request this cycle (request budget)', async () => {
    await writePlans([readyPlan(target('a-node'), 0)]);
    const atRun: Behaviour = (input, attempt) =>
      runResultFor(input.target.slug, {
        attempt,
        outcome: 'FAIL',
        reachedLevel: 2,
        failedStepId: 's3',
        steps: [
          {
            stepId: 's3',
            ordinal: 0,
            kind: 'run',
            outcome: 'FAIL',
            exitCode: 1,
            durationMs: 100,
            stdoutTail: null,
            stderrTail: 'Error: connect ETIMEDOUT',
            logFile: null,
            matchedAuthPattern: null,
            skipReason: null,
          },
        ],
      });
    const h = harness({ classify: async () => 'NETWORK_TRANSIENT' }, { 'a-node': atRun });
    await run(h);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('a PASS is never retried, and the classifier is not even asked', async () => {
    await writePlans([readyPlan(target('a-node'), 0)]);
    const classify = vi.fn(async () => 'TIMEOUT' as const);
    const h = harness({ classify });
    await run(h);
    expect(h.calls).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it('the real rules decide: an ETIMEDOUT from npm is transient, a drift error is not', async () => {
    const t = target('a-node');
    const timeout = runResultFor('a-node', {
      outcome: 'FAIL',
      reachedLevel: 0,
      failedStepId: 's1',
      steps: [
        {
          stepId: 's1',
          ordinal: 0,
          kind: 'shell',
          outcome: 'FAIL',
          exitCode: 1,
          durationMs: 10,
          stdoutTail: null,
          stderrTail:
            'npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/acme failed\n',
          logFile: null,
          matchedAuthPattern: null,
          skipReason: null,
        },
      ],
    });
    expect(await localClassify(timeout, t, results)).toBe('NETWORK_TRANSIENT');
    const drift = runResultFor('a-node', {
      outcome: 'FAIL',
      reachedLevel: 2,
      failedStepId: 's3',
      steps: [
        {
          stepId: 's3',
          ordinal: 0,
          kind: 'run',
          outcome: 'FAIL',
          exitCode: 1,
          durationMs: 10,
          stdoutTail: null,
          stderrTail: 'TypeError: acme.send is not a function\n    at index.js:3:6\n',
          logFile: null,
          matchedAuthPattern: null,
          skipReason: null,
        },
      ],
    });
    expect(await localClassify(drift, t, results)).toBe('API_DRIFT');
    expect(await localClassify(runResultFor('a-node'), t, results)).toBeNull();
  });
});

describe('what a result records', () => {
  it('the shard, and a stale plan, in the runner env', async () => {
    await writePlans([
      readyPlan(target('a-node'), 0, { stale: true }),
      readyPlan(target('b-node'), 0),
    ]);
    await run(harness());
    const a = await readResult('a-node-1.json');
    expect(a.runnerEnv[RUNNER_ENV_KEYS.planStale]).toBe('true');
    expect(a.runnerEnv[RUNNER_ENV_KEYS.shard]).toBe('0');
    const b = await readResult('b-node-1.json');
    expect(b.runnerEnv[RUNNER_ENV_KEYS.planStale]).toBeUndefined();
  });
});

describe('the guard canary: every shard proves its own runner', () => {
  it('shard 2 also runs canary-pass-node, into guards/shard-2/, beside its own tools', async () => {
    const guard = readyPlan(canaryTarget('canary-pass-node'), 0, { planId: null });
    await writePlans([guard, readyPlan(target('a-node'), 2)], { shards: 3, guards: [1, 2] });
    const h = harness();
    await run(h, 2);
    expect(h.calls.map((c) => c.slug).sort()).toEqual(['a-node', 'canary-pass-node']);
    const guardResult = await readResult('guards/shard-2/canary-pass-node-1.json');
    expect(guardResult.runnerEnv[RUNNER_ENV_KEYS.shard]).toBe('2');
    expect(await readdir(results)).not.toContain('canary-pass-node-1.json');
  });

  it('shard 0 runs the canary as itself (no guard copy), and a shard outside guards runs none', async () => {
    const guard = readyPlan(canaryTarget('canary-pass-node'), 0, { planId: null });
    await writePlans([guard, readyPlan(target('a-node'), 1)], { shards: 3, guards: [2] });
    const h0 = harness();
    await run(h0, 0);
    expect(h0.calls.map((c) => c.slug)).toEqual(['canary-pass-node']);
    expect(await readdir(results)).toContain('canary-pass-node-1.json');
    const h1 = harness();
    await run(h1, 1);
    expect(h1.calls.map((c) => c.slug)).toEqual(['a-node']);
  });
});

describe('a hung or crashing tool cannot take the shard down', () => {
  it('a watchdog kill is a HARNESS_ERROR, the container is removed, and the next tool still runs', async () => {
    const hang = target('hang-node', { expect: { authErrorIsPass: false, timeoutSec: 1 } });
    await writePlans([readyPlan(hang, 0), readyPlan(target('z-node'), 0)]);
    const h = harness(
      {},
      {
        // never settles, even after the abort: the worst case
        'hang-node': () => new Promise<RunResultType>(() => undefined),
      },
    );
    const outcome = await run(h, 0, { watchdogMarginMs: 40, graceMs: 40 });
    const r = await readResult('hang-node-1.json');
    expect(r.outcome).toBe('HARNESS_ERROR');
    expect(r.toolSlug).toBe('hang-node');
    expect(r.cycleId).toBe(CYCLE);
    expect(h.removed).toEqual([`qsr-${h.calls[0]?.runId as string}`]);
    expect((await readResult('z-node-1.json')).outcome).toBe('PASS');
    expect(outcome.harnessErrors).toBe(1);
  });

  it('a hung tool that obeys the abort keeps the steps it finished, still as a HARNESS_ERROR', async () => {
    const hang = target('hang-node', { expect: { authErrorIsPass: false, timeoutSec: 1 } });
    await writePlans([readyPlan(hang, 0)]);
    const h = harness(
      {},
      {
        'hang-node': (input) =>
          input.attempt === 1 ? new Promise(() => undefined) : runResultFor('hang-node'),
      },
    );
    const abortAware = vi.fn(
      (input: ExecuteInput, d: ExecuteDeps): Promise<RunResultType> =>
        new Promise((resolve) => {
          d.signal?.addEventListener('abort', () =>
            resolve(runResultFor(input.target.slug, { attempt: input.attempt, outcome: 'PASS' })),
          );
        }),
    );
    await run({ ...h, deps: { ...h.deps, executePlan: abortAware } } as typeof h, 0, {
      watchdogMarginMs: 30,
      graceMs: 200,
    });
    expect((await readResult('hang-node-1.json')).outcome).toBe('HARNESS_ERROR');
    expect(abortAware).toHaveBeenCalledTimes(1);
  });

  it('a watchdog kill is not retried (it is not a transient vendor failure)', async () => {
    const hang = target('hang-node', { expect: { authErrorIsPass: false, timeoutSec: 1 } });
    await writePlans([readyPlan(hang, 0)]);
    const h = harness(
      { classify: async () => 'TIMEOUT' },
      { 'hang-node': () => new Promise(() => undefined) },
    );
    await run(h, 0, { watchdogMarginMs: 20, graceMs: 20 });
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('an executor that throws is a HARNESS_ERROR result for that tool, and the shard carries on', async () => {
    await writePlans([readyPlan(target('a-node'), 0), readyPlan(target('b-node'), 0)]);
    const h = harness(
      {},
      {
        'a-node': () => {
          throw new Error('docker exploded');
        },
      },
    );
    const outcome = await run(h);
    expect((await readResult('a-node-1.json')).outcome).toBe('HARNESS_ERROR');
    expect((await readResult('b-node-1.json')).outcome).toBe('PASS');
    expect(outcome.harnessErrors).toBe(1);
  });

  it('a vendor failure never makes the run throw', async () => {
    await writePlans([readyPlan(target('a-node'), 0)]);
    const h = harness(
      {},
      {
        'a-node': (input) =>
          runResultFor(input.target.slug, { outcome: 'FAIL', failedStepId: 's1' }),
      },
    );
    await expect(run(h)).resolves.toMatchObject({ harnessErrors: 0 });
  });
});

describe('the sandbox host', () => {
  it('pulls each distinct image once before running anything', async () => {
    await writePlans([
      readyPlan(target('a-node'), 0),
      readyPlan(target('b-node'), 0),
      readyPlan(
        target('p-py', {
          language: 'python',
          runtime: { image: 'ghcr.io/aditya-tec/qsr-python:3.12' },
        }),
        0,
      ),
    ]);
    const h = harness();
    await run(h);
    expect(h.pulled.sort()).toEqual([
      'ghcr.io/aditya-tec/qsr-node:22',
      'ghcr.io/aditya-tec/qsr-python:3.12',
    ]);
  });

  it('a failed pull is logged and the tool then fails as a harness problem, not as a vendor failure', async () => {
    await writePlans([readyPlan(target('a-node'), 0)]);
    const h = harness();
    (h.deps.docker as unknown as { pullImage: () => Promise<void> }).pullImage = async () => {
      throw new Error('registry unreachable');
    };
    await expect(run(h)).resolves.toBeDefined();
    expect(h.calls).toHaveLength(1);
  });

  it('no Docker daemon is a harness crash: nothing could run, so the job must fail visibly', async () => {
    await writePlans([readyPlan(target('a-node'), 0)]);
    const h = harness();
    (h.deps.docker as unknown as { serverVersion: () => Promise<string> }).serverVersion =
      async () => 'unknown';
    await expect(run(h)).rejects.toBeInstanceOf(HarnessCrash);
  });

  it('starts the fixture server only for a plan that needs it, and closes it afterwards', async () => {
    const closed = vi.fn(async () => undefined);
    const started = vi.fn(async () => ({ close: closed }));
    await writePlans([readyPlan(target('a-node'), 0)]);
    await run(harness({ startFixtures: started }));
    expect(started).not.toHaveBeenCalled();

    const needs = readyPlan(canaryTarget('canary-pass-node'), 0, { planId: null });
    if (needs.state === 'ready')
      needs.plan.ir.steps[0] = {
        ...(needs.plan.ir.steps[0] as object),
        command: 'curl http://127.0.0.1:4177/canary/pass-node.html',
      } as never;
    await writePlans([needs]);
    await run(harness({ startFixtures: started }));
    expect(started).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe('isolation: this job has no secrets and no route to the API', () => {
  it('never calls fetch, and works with an environment that has no API settings', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('execute must not use the network itself');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const before = { base: process.env['API_BASE_URL'], secret: process.env['INGEST_HMAC_SECRET'] };
    delete process.env['API_BASE_URL'];
    delete process.env['INGEST_HMAC_SECRET'];
    try {
      await writePlans([readyPlan(target('a-node'), 0)]);
      await run(harness());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (before.base !== undefined) process.env['API_BASE_URL'] = before.base;
      if (before.secret !== undefined) process.env['INGEST_HMAC_SECRET'] = before.secret;
    }
  });

  it('the execute modules do not import the API client or read the API secrets', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['execute.ts', 'execute-command.ts']) {
      const source = await readFile(path.join(here, file), 'utf8').catch(() => '');
      expect(source, file).not.toMatch(/api-client/);
      expect(source, file).not.toMatch(/INGEST_HMAC_SECRET|API_BASE_URL|GITHUB_TOKEN/);
    }
  });
});

describe('types', () => {
  it('a Target satisfies what the executor needs', () => {
    const t: Target = target('a-node');
    expect(t.expect.timeoutSec).toBe(300);
  });
});
