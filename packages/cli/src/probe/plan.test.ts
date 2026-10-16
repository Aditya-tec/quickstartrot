import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrawlError } from '@qsr/crawler';
import { ApiError } from '../api-client.js';
import { Manifest, PlanFile, type CompileBody, type Extraction, type Target } from '@qsr/core';
import { runPlan, type PlanDeps, type PlanOptions } from './plan.js';
import {
  CYCLE,
  HASH,
  PLAN_ID,
  canaryTarget,
  cycleTool,
  extractionFor,
  fakeApi,
  ir,
  planPayload,
  recordingLogger,
  silent,
  target,
  type FakeApiOptions,
} from './probe.test-utils.js';

// `qsr plan` (spec section 12): wake the API, sync the targets, create the cycle (idempotent on the GitHub
// run), crawl every enabled target, call /internal/compile, write plans/<slug>.json, assign shards. The plan
// job has the secrets and never runs docs code.

const CANARY_SLUGS = [
  'canary-pass-node',
  'canary-pass-python',
  'canary-fail-drift',
  'canary-fail-dep',
];
const canaries = CANARY_SLUGS.map(canaryTarget);

let out: string;
beforeEach(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'qsr-plan-'));
});
afterEach(() => undefined);

interface Setup {
  real?: Target[];
  api?: FakeApiOptions;
  crawl?: PlanDeps['crawl'];
  golden?: PlanDeps['goldenPlan'];
  options?: Partial<PlanOptions>;
  concurrency?: number;
}

async function plan(s: Setup = {}) {
  const real = s.real ?? [target('acme-node'), target('bolt-node')];
  const all = [...real, ...canaries];
  const fake = fakeApi({
    tools: all.map((t) => cycleTool(t)),
    ...s.api,
  });
  const outputs: Record<string, string> = {};
  const summaries: string[] = [];
  const crawled: string[] = [];
  const logger = recordingLogger();
  const deps: PlanDeps = {
    api: fake.api,
    targets: { real, canaries },
    crawl:
      s.crawl ??
      (async (t) => {
        crawled.push(t.slug);
        return extractionFor(t);
      }),
    goldenPlan: s.golden ?? (async () => ir('canary')),
    log: logger,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    writeOutput: async (name, value) => void (outputs[name] = value),
    writeSummary: async (md) => void summaries.push(md),
    ...(s.concurrency ? { concurrency: s.concurrency } : {}),
  };
  const options: PlanOptions = {
    out,
    only: [],
    trigger: 'manual',
    gitSha: 'abcdef1234567',
    ghRunId: 4242,
    ghRunAttempt: 2,
    ...s.options,
  };
  const result = await runPlan(options, deps);
  return { result, fake, outputs, summaries, crawled, logger };
}

const readPlan = async (slug: string): Promise<PlanFile> =>
  PlanFile.parse(JSON.parse(await readFile(path.join(out, `${slug}.json`), 'utf8')));
const readManifest = async (): Promise<Manifest> =>
  Manifest.parse(JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')));

describe('the order of things', () => {
  it('wakes the API, syncs ALL targets (canaries too), then creates the cycle with the GitHub run ids', async () => {
    const { fake } = await plan();
    const paths = fake.paths();
    expect(paths.slice(0, 3)).toEqual(['wake', '/internal/targets/sync', '/internal/cycles']);
    const sync = fake.calls[1]?.body as { targets: { slug: string }[] };
    expect(sync.targets.map((t) => t.slug).sort()).toEqual(
      ['acme-node', 'bolt-node', ...CANARY_SLUGS].sort(),
    );
    expect(fake.calls[2]?.body).toEqual({
      trigger: 'manual',
      gitSha: 'abcdef1234567',
      ghRunId: 4242,
      ghRunAttempt: 2,
    });
  });

  it('prints shards (a JSON array for the matrix) and cycle to GITHUB_OUTPUT', async () => {
    const { outputs } = await plan();
    expect(outputs['cycle']).toBe(CYCLE);
    expect(JSON.parse(outputs['shards'] as string)).toEqual([0, 1]);
  });
});

describe('what it plans', () => {
  it('compiles each real tool and writes a ready plan with the plan id, the snapshot and the shard', async () => {
    const { fake } = await plan();
    const compile = fake.calls.filter((c) => c.path === '/internal/compile');
    expect(compile.map((c) => (c.body as CompileBody).toolSlug).sort()).toEqual([
      'acme-node',
      'bolt-node',
    ]);
    expect((compile[0]?.body as CompileBody).cycleId).toBe(CYCLE);

    const acme = await readPlan('acme-node');
    expect(acme).toMatchObject({
      state: 'ready',
      toolSlug: 'acme-node',
      cycleId: CYCLE,
      isCanary: false,
      plan: { planId: PLAN_ID, snapshotHash: HASH, stale: false, compilerVersion: '2026-10-16.5' },
    });
    if (acme.state === 'ready') expect(acme.shard).toBeGreaterThanOrEqual(0);
  });

  it('canaries are crawled from the fixtures and run their GOLDEN plan: no compile call, no plan id', async () => {
    const { fake } = await plan();
    const compiled = fake.calls
      .filter((c) => c.path === '/internal/compile')
      .map((c) => (c.body as CompileBody).toolSlug);
    expect(compiled.some((s) => s.startsWith('canary-'))).toBe(false);
    const canary = await readPlan('canary-pass-node');
    expect(canary).toMatchObject({ state: 'ready', isCanary: true, plan: { planId: null } });
  });

  it('a golden plan that no longer matches the fixture page fails that canary before it runs', async () => {
    const { fake } = await plan({
      golden: async (t) => {
        if (t.slug === 'canary-fail-dep') throw new Error('is no longer grounded');
        return ir('canary');
      },
    });
    const c = await readPlan('canary-fail-dep');
    expect(c.state).toBe('pre_failed');
    expect(fake.paths()).not.toContain('canary-fail-dep');
  });

  it('--only limits the real tools, but the canaries always stay (a cycle without them is invalid)', async () => {
    const { crawled, fake } = await plan({ options: { only: ['acme-node'] } });
    expect(crawled).toContain('acme-node');
    expect(crawled).not.toContain('bolt-node');
    expect(await readdir(out)).toEqual(
      expect.arrayContaining(['acme-node.json', 'canary-pass-node.json', 'manifest.json']),
    );
    expect(await readdir(out)).not.toContain('bolt-node.json');
    expect(fake.calls.filter((c) => c.path === '/internal/compile')).toHaveLength(1);
  });

  it('a tool the API does not list as enabled is not planned', async () => {
    const real = [target('acme-node'), target('bolt-node')];
    const { crawled } = await plan({
      real,
      api: { tools: [...real.slice(0, 1), ...canaries].map((t) => cycleTool(t)) },
    });
    expect(crawled).not.toContain('bolt-node');
  });

  it('a tool the API lists but that has no file here is skipped with a warning, not a crash', async () => {
    const real = [target('acme-node')];
    const ghost = target('ghost-node');
    const { logger } = await plan({
      real,
      api: { tools: [...real, ghost, ...canaries].map((t) => cycleTool(t)) },
    });
    expect(
      logger.lines.some((l) => l.level === 'warn' && l.fields['toolSlug'] === 'ghost-node'),
    ).toBe(true);
  });
});

describe('the four compile outcomes', () => {
  const okFor = () => ({
    status: 'ok',
    fromCache: true,
    stale: false,
    snapshotId: PLAN_ID,
    plan: planPayload(),
  });

  it('an accepted plan is ready', async () => {
    await plan({ api: { compile: okFor } });
    expect((await readPlan('acme-node')).state).toBe('ready');
  });

  it('a stale plan from a budget deferral is used AND flagged, in the plan file, the manifest and the summary', async () => {
    const { summaries } = await plan({
      api: {
        compile: (b) =>
          b.toolSlug === 'acme-node'
            ? {
                status: 'deferred',
                reason: 'llm_budget',
                snapshotId: PLAN_ID,
                stale: true,
                plan: planPayload({ contentHash: 'b'.repeat(64) }),
              }
            : okFor(),
      },
    });
    const acme = await readPlan('acme-node');
    expect(acme).toMatchObject({ state: 'ready', plan: { stale: true } });
    // the run records the page as crawled now, but the plan it executes is the older one
    if (acme.state === 'ready') expect(acme.plan.snapshotHash).toBe(HASH);
    expect((await readManifest()).tools.find((t) => t.toolSlug === 'acme-node')?.stale).toBe(true);
    expect((await readPlan('bolt-node')).state === 'ready').toBe(true);
    expect(summaries.join('\n')).toMatch(/acme-node.*stale/i);
  });

  it('a deferral with no earlier plan is an informational skip: no run will be posted', async () => {
    const { summaries } = await plan({
      api: {
        compile: () => ({
          status: 'deferred',
          reason: 'llm_unavailable',
          snapshotId: PLAN_ID,
          stale: false,
          plan: null,
        }),
      },
    });
    const acme = await readPlan('acme-node');
    expect(acme).toMatchObject({ state: 'deferred', reason: 'llm_unavailable' });
    expect(summaries.join('\n')).toMatch(/acme-node.*skipped/i);
    expect((await readManifest()).tools.find((t) => t.toolSlug === 'acme-node')).toMatchObject({
      state: 'deferred',
      shard: null,
    });
  });

  it('a rejected plan (COMPILER_ERROR) is pre-failed, with the rejected plan id, and never executed', async () => {
    await plan({
      api: {
        compile: () => ({
          status: 'compiler_error',
          failureClass: 'COMPILER_ERROR',
          snapshotId: PLAN_ID,
          plan: planPayload({ accepted: false }),
        }),
      },
    });
    const acme = await readPlan('acme-node');
    expect(acme).toMatchObject({
      state: 'pre_failed',
      planId: PLAN_ID,
      snapshotHash: HASH,
      preflight: { stage: 'compile', failureClass: 'COMPILER_ERROR', reason: 'rejected_twice' },
    });
    expect((await readManifest()).tools.find((t) => t.toolSlug === 'acme-node')?.shard).toBeNull();
  });

  it('a crawl error is pre-failed, is told to the API for the admin queue, and nothing is compiled for it', async () => {
    const { fake } = await plan({
      crawl: async (t) => {
        if (t.slug === 'acme-node') throw new CrawlError('no_code_blocks', 'the page has no code');
        return extractionFor(t);
      },
    });
    const acme = await readPlan('acme-node');
    expect(acme).toMatchObject({
      state: 'pre_failed',
      preflight: { stage: 'crawl', failureClass: 'CRAWL_ERROR', reason: 'no_code_blocks' },
    });
    const bodies = fake.calls
      .filter((c) => c.path === '/internal/compile')
      .map((c) => c.body as CompileBody)
      .filter((b) => b.toolSlug === 'acme-node');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      crawlError: { reason: 'no_code_blocks', message: 'the page has no code' },
    });
    expect(bodies[0]?.extraction).toBeUndefined();
  });

  it('an unexpected crawler crash is also a crawl error for that tool, and the others carry on', async () => {
    await plan({
      crawl: async (t) => {
        if (t.slug === 'acme-node') throw new TypeError('browser crashed');
        return extractionFor(t);
      },
    });
    expect(await readPlan('acme-node')).toMatchObject({
      state: 'pre_failed',
      preflight: { failureClass: 'CRAWL_ERROR', reason: 'crawler_crash' },
    });
    expect((await readPlan('bolt-node')).state).toBe('ready');
  });

  it('a failing compile CALL (API down) is a skip, never a verdict on the tool', async () => {
    const { logger } = await plan({
      api: {
        compile: (b) => {
          if (b.toolSlug === 'acme-node')
            throw new ApiError(503, 'Service Unavailable', undefined, 'POST x');
          return okFor();
        },
      },
    });
    expect(await readPlan('acme-node')).toMatchObject({
      state: 'deferred',
      reason: 'llm_unavailable',
    });
    expect(
      logger.lines.some((l) => l.level === 'error' && l.fields['toolSlug'] === 'acme-node'),
    ).toBe(true);
  });
});

describe('shards', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => target(`tool-${String(i).padStart(2, '0')}`));

  it('defaults to min(10, ceil(tools / 4)) over the tools that will run', async () => {
    // 10 real + 4 canaries = 14 runnable -> 4 shards
    const { result, outputs } = await plan({ real: many(10) });
    expect(result.shards).toBe(4);
    expect(JSON.parse(outputs['shards'] as string)).toEqual([0, 1, 2, 3]);
    expect((await readManifest()).guards).toEqual([1, 2, 3]);
  });

  it('--shards overrides the default', async () => {
    const { result } = await plan({ real: many(10), options: { shards: 2 } });
    expect(result.shards).toBe(2);
  });

  it('assigns the heaviest tools first, from the durations the cycles response carries', async () => {
    const real = many(4);
    const all = [...real, ...canaries];
    const {} = {};
    await plan({
      real,
      options: { shards: 2 },
      api: {
        tools: all.map((t) =>
          cycleTool(t, {
            lastDurationMs: t.slug === 'tool-03' ? 900_000 : t.slug === 'tool-02' ? 500_000 : 1_000,
          }),
        ),
      },
    });
    const shardOf = async (slug: string) => {
      const p = await readPlan(slug);
      return p.state === 'ready' ? p.shard : -1;
    };
    // tool-03 (heaviest) -> 0, tool-02 -> 1, then 00 -> 0, 01 -> 1
    expect(await shardOf('tool-03')).toBe(0);
    expect(await shardOf('tool-02')).toBe(1);
    expect((await readPlan('tool-03')).weightMs).toBe(900_000);
  });

  it('canary-pass-node is a guard in every other shard and the other canaries sit in shard 0', async () => {
    await plan({ options: { shards: 3 } });
    const m = await readManifest();
    expect(m.guards).toEqual([1, 2]);
    for (const slug of [
      'canary-pass-node',
      'canary-pass-python',
      'canary-fail-drift',
      'canary-fail-dep',
    ])
      expect(m.tools.find((t) => t.toolSlug === slug)?.shard).toBe(0);
  });

  it('a pre-failed canary-pass-node leaves no guard to run', async () => {
    await plan({
      golden: async (t) => {
        if (t.slug === 'canary-pass-node') throw new Error('not grounded');
        return ir('canary');
      },
      options: { shards: 2 },
    });
    expect((await readManifest()).guards).toEqual([]);
  });
});

describe('crawl politeness', () => {
  it('crawls at most 4 pages at once and never two from the same domain at once', async () => {
    const real = Array.from({ length: 12 }, (_, i) =>
      target(`t${i}`, { docsUrl: `https://docs.${i % 3 === 0 ? 'shared' : `host${i}`}.dev/q${i}` }),
    );
    let active = 0;
    let peak = 0;
    const perDomain = new Map<string, number>();
    let sameDomain = false;
    const { crawled } = await plan({
      real,
      crawl: async (t) => {
        const domain = new URL(t.docsUrl).host;
        active += 1;
        peak = Math.max(peak, active);
        perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
        if ((perDomain.get(domain) ?? 0) > 1) sameDomain = true;
        await new Promise((r) => setTimeout(r, 8));
        perDomain.set(domain, (perDomain.get(domain) ?? 1) - 1);
        active -= 1;
        return extractionFor(t);
      },
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(sameDomain).toBe(false);
    expect(crawled).toEqual([]); // the custom crawler replaced the recording one
  });

  it('crawls each page exactly once per cycle', async () => {
    const seen: string[] = [];
    await plan({
      crawl: async (t) => {
        seen.push(t.slug);
        return extractionFor(t);
      },
    });
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(2 + canaries.length);
  });
});

describe('the plan summary', () => {
  it('lists what will run, what was flagged and what was skipped', async () => {
    const { summaries } = await plan({
      api: {
        compile: (b) =>
          b.toolSlug === 'acme-node'
            ? {
                status: 'compiler_error',
                failureClass: 'COMPILER_ERROR',
                snapshotId: PLAN_ID,
                plan: planPayload({ accepted: false }),
              }
            : {
                status: 'ok',
                fromCache: true,
                stale: false,
                snapshotId: PLAN_ID,
                plan: planPayload(),
              },
      },
    });
    const md = summaries.join('\n');
    expect(md).toContain(CYCLE);
    expect(md).toMatch(/acme-node.*COMPILER_ERROR/);
    expect(md).toMatch(/bolt-node/);
  });
});

describe('type-level sanity of the extraction fixture', () => {
  it('is a valid Extraction', () => {
    const e: Extraction = extractionFor(target('x'));
    expect(e.blocks).toHaveLength(1);
    void silent;
  });
});
