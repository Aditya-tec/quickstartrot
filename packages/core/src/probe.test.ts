import { describe, expect, it } from 'vitest';
import {
  CompileBody,
  CompileResponse,
  CycleTool,
  Manifest,
  PlanFile,
  PreflightFailure,
  RUNNER_ENV_KEYS,
  RunBody,
  type PlanFile as PlanFileType,
} from './index.js';

// The files the probe pipeline hands between its three jobs (spec section 12): plans/<slug>.json and
// plans/manifest.json from `qsr plan`, read by `qsr execute` and `qsr report`. Artifacts cross a trust
// boundary (execute runs on another machine), so both ends parse them with these schemas.

const CYCLE = '5d1b8c1e-2f4a-4b8e-9d3c-0123456789ab';
const PLAN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const target = {
  slug: 'acme-node',
  name: 'Acme',
  docsUrl: 'https://docs.acme.dev/quickstart',
  language: 'node',
  level: 2,
  runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22' },
  extract: { root: 'main' },
};
const ir = {
  irVersion: 1,
  language: 'node',
  projectInit: 'none',
  maxLevelReachable: 2,
  notes: '',
  steps: [
    {
      kind: 'shell',
      id: 's1',
      command: 'npm install acme',
      source: { blockIndex: 1, lineStart: 1, lineEnd: 1 },
      expect: { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 },
    },
  ],
};

const base = { version: 1, toolSlug: 'acme-node', cycleId: CYCLE, isCanary: false, weightMs: null };

describe('PlanFile', () => {
  it('accepts a ready plan, and applies the target defaults', () => {
    const parsed = PlanFile.parse({
      ...base,
      state: 'ready',
      shard: 0,
      target,
      plan: {
        planId: PLAN_ID,
        snapshotHash: 'a'.repeat(64),
        ir,
        stale: false,
        compilerVersion: '2026-10-16.5',
      },
    });
    expect(parsed.state).toBe('ready');
    if (parsed.state === 'ready') expect(parsed.target.expect.timeoutSec).toBe(300);
  });

  it('a canary plan has no plan id (its golden plan is committed, not compiled)', () => {
    const parsed = PlanFile.parse({
      ...base,
      toolSlug: 'canary-pass-node',
      isCanary: true,
      state: 'ready',
      shard: 0,
      target: { ...target, slug: 'canary-pass-node' },
      plan: { planId: null, snapshotHash: 'b'.repeat(64), ir, stale: false, compilerVersion: null },
    });
    expect(parsed.state).toBe('ready');
  });

  it('accepts a pre-failed entry with the failure the report job will post', () => {
    const parsed = PlanFile.parse({
      ...base,
      state: 'pre_failed',
      target,
      preflight: {
        stage: 'crawl',
        failureClass: 'CRAWL_ERROR',
        reason: 'no_code_blocks',
        message: 'the page has no code blocks',
      },
      planId: null,
      snapshotHash: null,
    });
    expect(parsed.state).toBe('pre_failed');
  });

  it('accepts a deferred entry (no plan, nothing to post)', () => {
    expect(PlanFile.parse({ ...base, state: 'deferred', target, reason: 'llm_budget' }).state).toBe(
      'deferred',
    );
  });

  it('a ready plan needs a shard and a plan; a pre-failed one needs a preflight', () => {
    const ready = { ...base, state: 'ready', target };
    expect(PlanFile.safeParse(ready).success).toBe(false);
    expect(PlanFile.safeParse({ ...ready, shard: 0 }).success).toBe(false);
    expect(PlanFile.safeParse({ ...base, state: 'pre_failed', target }).success).toBe(false);
  });

  it('rejects an unknown state, a wrong version and a negative shard', () => {
    expect(PlanFile.safeParse({ ...base, state: 'weird', target }).success).toBe(false);
    expect(
      PlanFile.safeParse({ ...base, version: 2, state: 'deferred', target, reason: 'llm_budget' })
        .success,
    ).toBe(false);
    const ok = {
      ...base,
      state: 'ready',
      target,
      plan: { planId: null, snapshotHash: null, ir, stale: false, compilerVersion: null },
    };
    expect(PlanFile.safeParse({ ...ok, shard: -1 }).success).toBe(false);
  });

  it('a ready plan carries a validated Step IR, so a tampered artifact is refused', () => {
    const bad = {
      ...base,
      state: 'ready',
      shard: 0,
      target,
      plan: {
        planId: null,
        snapshotHash: null,
        ir: { steps: 'rm -rf /' },
        stale: false,
        compilerVersion: null,
      },
    };
    expect(PlanFile.safeParse(bad).success).toBe(false);
  });
});

describe('Manifest', () => {
  const entry = { toolSlug: 'acme-node', state: 'ready', shard: 1, stale: false, isCanary: false };

  it('lists every tool of the cycle with its state and shard', () => {
    const m = Manifest.parse({
      version: 1,
      cycleId: CYCLE,
      createdAt: '2026-10-16T12:00:00.000Z',
      shards: 2,
      tools: [
        entry,
        { toolSlug: 'b-node', state: 'pre_failed', shard: null, stale: false, isCanary: false },
        { toolSlug: 'c-node', state: 'deferred', shard: null, stale: false, isCanary: false },
      ],
    });
    expect(m.tools).toHaveLength(3);
  });

  it('records the shards that also run the guard canary (default none)', () => {
    const m = {
      version: 1,
      cycleId: CYCLE,
      createdAt: '2026-10-16T12:00:00.000Z',
      shards: 3,
      tools: [entry],
    };
    expect(Manifest.parse(m).guards).toEqual([]);
    expect(Manifest.parse({ ...m, guards: [1, 2] }).guards).toEqual([1, 2]);
    expect(Manifest.safeParse({ ...m, guards: [3] }).success).toBe(false);
    expect(Manifest.safeParse({ ...m, guards: [0] }).success).toBe(false);
  });

  it('needs at least one shard and a valid cycle id', () => {
    const m = { version: 1, cycleId: CYCLE, createdAt: '2026-10-16T12:00:00.000Z', tools: [entry] };
    expect(Manifest.safeParse({ ...m, shards: 0 }).success).toBe(false);
    expect(Manifest.safeParse({ ...m, shards: 1, cycleId: 'x' }).success).toBe(false);
  });

  it('a shard that does not exist is refused (an entry on shard 3 of 2)', () => {
    const m = {
      version: 1,
      cycleId: CYCLE,
      createdAt: '2026-10-16T12:00:00.000Z',
      shards: 2,
      tools: [{ ...entry, shard: 3 }],
    };
    expect(Manifest.safeParse(m).success).toBe(false);
  });
});

describe('PreflightFailure and the ingest body', () => {
  const preflight = {
    stage: 'compile',
    failureClass: 'COMPILER_ERROR',
    reason: 'rejected_twice',
    message: 'x',
  };

  it('only the two pre-execution classes are allowed', () => {
    expect(PreflightFailure.safeParse(preflight).success).toBe(true);
    expect(PreflightFailure.safeParse({ ...preflight, failureClass: 'API_DRIFT' }).success).toBe(
      false,
    );
    expect(PreflightFailure.safeParse({ ...preflight, stage: 'execute' }).success).toBe(false);
  });

  it('RunBody takes an optional preflight beside the RunResult, which is not changed', () => {
    const runResult = {
      toolSlug: 'acme-node',
      cycleId: CYCLE,
      attempt: 1,
      planId: null,
      snapshotHash: null,
      outcome: 'FAIL',
      reachedLevel: 0,
      failedStepId: null,
      steps: [],
      imageDigest: 'none',
      runnerEnv: {},
      startedAt: '2026-10-16T12:00:00.000Z',
      finishedAt: '2026-10-16T12:00:00.000Z',
    };
    expect(RunBody.parse({ runResult }).preflight).toBeUndefined();
    expect(RunBody.parse({ runResult, preflight }).preflight?.failureClass).toBe('COMPILER_ERROR');
  });
});

describe('cycle tools and runner env keys', () => {
  it('CycleTool may carry the last duration of the tool, for heaviest-first sharding', () => {
    const t = {
      slug: 'a',
      name: 'A',
      docsUrl: 'https://a.dev',
      language: 'node',
      level: 2,
      isCanary: false,
    };
    expect(CycleTool.parse(t).lastDurationMs).toBeNull();
    expect(CycleTool.parse({ ...t, lastDurationMs: 4200 }).lastDurationMs).toBe(4200);
  });

  it('the runner env records a stale plan and the shard under fixed keys', () => {
    expect(RUNNER_ENV_KEYS.planStale).toBe('plan_stale');
    expect(RUNNER_ENV_KEYS.shard).toBe('shard');
  });

  it('the runner env says why a passing run step did not make L3 under the key "l3" (harness v3)', () => {
    expect(RUNNER_ENV_KEYS.l3).toBe('l3');
  });
});

describe('compile request and response additions (P7 tidy-up)', () => {
  const base = { cycleId: CYCLE, toolSlug: 'acme-node', crawlError: { reason: 'x', message: 'y' } };

  it('CompileBody takes modelAllowed, true unless said otherwise', () => {
    expect(CompileBody.parse(base).modelAllowed).toBe(true);
    expect(CompileBody.parse({ ...base, modelAllowed: false }).modelAllowed).toBe(false);
  });

  it('a deferred answer carries retryAfterSeconds, null when the provider gave none', () => {
    const deferred = {
      status: 'deferred',
      reason: 'llm_unavailable',
      snapshotId: CYCLE,
      stale: false,
      plan: null,
    };
    expect(CompileResponse.parse(deferred)).toMatchObject({ retryAfterSeconds: null });
    expect(CompileResponse.parse({ ...deferred, retryAfterSeconds: 42 })).toMatchObject({
      retryAfterSeconds: 42,
    });
  });
});

describe('type check', () => {
  it('PlanFile is a discriminated union on state', () => {
    const f = null as unknown as PlanFileType;
    if (f && f.state === 'ready') expect(f.shard).toBeGreaterThanOrEqual(0);
    expect(true).toBe(true);
  });
});
