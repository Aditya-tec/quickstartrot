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

const START_MS = Date.parse('2026-10-16T12:00:00.000Z');
/** A fake clock: it moves only when something sleeps or a fake compile call "takes time". */
const clock = { ms: START_MS };
const sleepLog: number[] = [];

async function plan(s: Setup = {}) {
  clock.ms = START_MS;
  sleepLog.length = 0;
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
    now: () => new Date(clock.ms),
    sleep: async (ms) => {
      sleepLog.push(ms);
      clock.ms += ms;
    },
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
  return { result, fake, outputs, summaries, crawled, logger, sleeps: [...sleepLog] };
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

describe('the compile phase: crawl together, compile one at a time, in order', () => {
  const okReply = () => ({
    status: 'ok',
    fromCache: false,
    stale: false,
    snapshotId: PLAN_ID,
    plan: planPayload(),
  });
  const deferred = (over: Record<string, unknown> = {}) => ({
    status: 'deferred',
    reason: 'llm_unavailable',
    snapshotId: PLAN_ID,
    stale: false,
    plan: null,
    retryAfterSeconds: null,
    ...over,
  });
  const staleDeferred = (over: Record<string, unknown> = {}) =>
    deferred({ stale: true, plan: planPayload({ contentHash: 'b'.repeat(64) }), ...over });
  const real3 = [target('b-node'), target('c-node'), target('a-node')];
  const compileBodies = (calls: { path: string; body: unknown }[]): CompileBody[] =>
    calls.filter((c) => c.path === '/internal/compile').map((c) => c.body as CompileBody);
  const callsFor = (calls: { path: string; body: unknown }[], slug: string) =>
    compileBodies(calls).filter((b) => b.toolSlug === slug);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const http = (status: number, retryAfterS: number | null = null) =>
    new ApiError(status, 'x', undefined, 'POST /internal/compile', retryAfterS);

  it('compile calls never overlap and go in slug order, however the crawls finished', async () => {
    const order: string[] = [];
    let active = 0;
    let overlap = false;
    await plan({
      real: real3,
      // a-node crawls slowest: crawling is concurrent, compiling must not follow the order crawls finish in
      crawl: async (t) => {
        await wait(t.slug === 'a-node' ? 30 : t.slug === 'b-node' ? 15 : 1);
        return extractionFor(t);
      },
      api: {
        compile: async (b) => {
          active += 1;
          if (active > 1) overlap = true;
          order.push(b.toolSlug);
          await wait(5);
          active -= 1;
          return okReply();
        },
      },
    });
    expect(overlap).toBe(false);
    expect(order).toEqual(['a-node', 'b-node', 'c-node']);
  });

  it('crawling still overlaps: the compile phase starts only once the pages are in', async () => {
    let active = 0;
    let peak = 0;
    await plan({
      real: real3,
      crawl: async (t) => {
        active += 1;
        peak = Math.max(peak, active);
        await wait(15);
        active -= 1;
        return extractionFor(t);
      },
    });
    expect(peak).toBeGreaterThan(1);
  });

  it('a 429 from the API once: waits its Retry-After, retries once, and the plan is accepted', async () => {
    let n = 0;
    const r = await plan({
      api: {
        compile: (b) => {
          if (b.toolSlug === 'acme-node' && n++ === 0) throw http(429, 12);
          return okReply();
        },
      },
    });
    expect(r.sleeps).toEqual([12_000]);
    expect(callsFor(r.fake.calls, 'acme-node')).toHaveLength(2);
    expect((await readPlan('acme-node')).state).toBe('ready');
  });

  it('a 5xx from the API with no Retry-After waits the 30 s default', async () => {
    let n = 0;
    const r = await plan({
      api: {
        compile: (b) => {
          if (b.toolSlug === 'acme-node' && n++ === 0) throw http(500);
          return okReply();
        },
      },
    });
    expect(r.sleeps).toEqual([30_000]);
  });

  it('a provider rate limit reported as a deferral is retried once too: its Retry-After, else 30 s', async () => {
    let first = true;
    const a = await plan({
      api: {
        compile: (b) => {
          if (b.toolSlug === 'acme-node' && first) {
            first = false;
            return deferred({ retryAfterSeconds: 8 });
          }
          return okReply();
        },
      },
    });
    expect(a.sleeps).toEqual([8_000]);
    expect((await readPlan('acme-node')).state).toBe('ready');

    let again = true;
    const b = await plan({
      api: {
        compile: (body) => {
          if (body.toolSlug === 'acme-node' && again) {
            again = false;
            return deferred({ reason: 'llm_timeout' });
          }
          return okReply();
        },
      },
    });
    expect(b.sleeps).toEqual([30_000]);
  });

  it('429 twice: never a third try. With an earlier plan it runs flagged stale, without one it is an informational skip', async () => {
    const twice = (withStale: boolean) => ({
      compile: (b: CompileBody) =>
        b.toolSlug === 'acme-node' ? (withStale ? staleDeferred() : deferred()) : okReply(),
    });
    const stale = await plan({ api: twice(true) });
    expect(callsFor(stale.fake.calls, 'acme-node')).toHaveLength(2);
    expect(await readPlan('acme-node')).toMatchObject({ state: 'ready', plan: { stale: true } });

    const none = await plan({ api: twice(false) });
    expect(callsFor(none.fake.calls, 'acme-node')).toHaveLength(2);
    expect(await readPlan('acme-node')).toMatchObject({
      state: 'deferred',
      reason: 'llm_unavailable',
    });
  });

  it('the API failing twice with a 5xx asks once more, without the model, for the cache or the stale plan', async () => {
    const r = await plan({
      api: {
        compile: (b) => {
          if (b.toolSlug !== 'acme-node') return okReply();
          if (b.modelAllowed === false) return staleDeferred({ reason: 'llm_timeout' });
          throw http(503);
        },
      },
    });
    expect(callsFor(r.fake.calls, 'acme-node').map((c) => c.modelAllowed)).toEqual([
      undefined,
      undefined,
      false,
    ]);
    expect(await readPlan('acme-node')).toMatchObject({ state: 'ready', plan: { stale: true } });
  });

  it('...and if even that fails, the tool is a plain informational skip', async () => {
    await plan({
      api: {
        compile: (b) => {
          if (b.toolSlug !== 'acme-node') return okReply();
          throw http(503);
        },
      },
    });
    expect(await readPlan('acme-node')).toMatchObject({
      state: 'deferred',
      reason: 'llm_unavailable',
    });
  });

  it('a Retry-After longer than 2 minutes (a daily limit) is not waited for: deferred at once', async () => {
    const r = await plan({
      api: {
        compile: (b) =>
          b.toolSlug === 'acme-node' ? deferred({ retryAfterSeconds: 7_200 }) : okReply(),
      },
    });
    expect(r.sleeps).toEqual([]);
    expect(callsFor(r.fake.calls, 'acme-node')).toHaveLength(1);
    expect((await readPlan('acme-node')).state).toBe('deferred');
  });

  it('our own token budget (llm_budget) is not retried: waiting cannot help', async () => {
    const r = await plan({
      api: {
        compile: (b) =>
          b.toolSlug === 'acme-node' ? deferred({ reason: 'llm_budget' }) : okReply(),
      },
    });
    expect(r.sleeps).toEqual([]);
    expect(callsFor(r.fake.calls, 'acme-node')).toHaveLength(1);
    expect(await readPlan('acme-node')).toMatchObject({ state: 'deferred', reason: 'llm_budget' });
  });

  it('an error that is not an HTTP answer (a malformed response) is not retried either', async () => {
    const r = await plan({
      api: { compile: (b) => (b.toolSlug === 'acme-node' ? { garbage: true } : okReply()) },
    });
    expect(r.sleeps).toEqual([]);
    expect(callsFor(r.fake.calls, 'acme-node')).toHaveLength(1);
    expect((await readPlan('acme-node')).state).toBe('deferred');
  });

  describe('the 15-minute cap on the whole phase (fake clock)', () => {
    const ten = Array.from({ length: 10 }, (_, i) => target(`t${String(i).padStart(2, '0')}-node`));

    it('tools not reached in time are asked once without the model: cache or stale plan, else a skip', async () => {
      const r = await plan({
        real: ten,
        api: {
          compile: (b) => {
            if (b.modelAllowed === false)
              return b.toolSlug === 't09-node'
                ? staleDeferred({ reason: 'llm_timeout' })
                : deferred({ reason: 'llm_timeout' });
            clock.ms += 2 * 60_000; // every real compile "takes" two minutes
            return okReply();
          },
        },
      });
      const bodies = compileBodies(r.fake.calls);
      // starts at minutes 0, 2, ... 14 are inside the cap: 8 tools; the 9th would start at minute 16
      expect(bodies.filter((b) => b.modelAllowed !== false).map((b) => b.toolSlug)).toEqual(
        ten.slice(0, 8).map((t) => t.slug),
      );
      expect(bodies.filter((b) => b.modelAllowed === false).map((b) => b.toolSlug)).toEqual([
        't08-node',
        't09-node',
      ]);
      expect(await readPlan('t08-node')).toMatchObject({
        state: 'deferred',
        reason: 'llm_timeout',
      });
      expect(await readPlan('t09-node')).toMatchObject({ state: 'ready', plan: { stale: true } });
      expect((await readPlan('t07-node')).state).toBe('ready');
    });

    it('time spent waiting for a retry counts against the cap too', async () => {
      // every tool is rate limited once for 100 s: 9 tools use 900 s = 15 minutes, so the 10th is out of time
      const limited = new Set<string>();
      const r = await plan({
        real: ten,
        api: {
          compile: (b) => {
            if (b.modelAllowed === false) return deferred({ reason: 'llm_timeout' });
            if (!limited.has(b.toolSlug)) {
              limited.add(b.toolSlug);
              return deferred({ retryAfterSeconds: 100 });
            }
            return okReply();
          },
        },
      });
      const bodies = compileBodies(r.fake.calls);
      expect(bodies.filter((b) => b.modelAllowed === false).map((b) => b.toolSlug)).toEqual([
        't09-node',
      ]);
      expect(bodies.filter((b) => b.modelAllowed !== false)).toHaveLength(18);
    });

    it('everything finishing in time never uses the no-model call', async () => {
      const r = await plan({ real: ten });
      expect(compileBodies(r.fake.calls).filter((b) => b.modelAllowed === false)).toHaveLength(0);
    });
  });

  it('deferral never becomes a verdict: no COMPILER_ERROR entry, no run posted, only skips or flagged plans', async () => {
    const r = await plan({
      real: real3,
      api: {
        compile: (b) =>
          b.toolSlug === 'a-node'
            ? deferred()
            : b.toolSlug === 'b-node'
              ? staleDeferred()
              : deferred({ reason: 'llm_budget' }),
      },
    });
    const files = await Promise.all(['a-node', 'b-node', 'c-node'].map(readPlan));
    expect(files.map((f) => f.state)).toEqual(['deferred', 'ready', 'deferred']);
    for (const f of files) {
      expect(f.state).not.toBe('pre_failed');
      expect(JSON.stringify(f)).not.toContain('COMPILER_ERROR');
    }
    // the plan job never posts runs or finishes the cycle, so no status can move
    expect(r.fake.paths().filter((p) => p === '/internal/runs' || p.endsWith('/finish'))).toEqual(
      [],
    );
  });
});

describe('the Groq circuit breaker: after the first daily-limit signal nobody asks the model again', () => {
  const okReply = () => ({
    status: 'ok',
    fromCache: false,
    stale: false,
    snapshotId: PLAN_ID,
    plan: planPayload(),
  });
  const deferred = (over: Record<string, unknown> = {}) => ({
    status: 'deferred',
    reason: 'llm_unavailable',
    snapshotId: PLAN_ID,
    stale: false,
    plan: null,
    retryAfterSeconds: null,
    ...over,
  });
  const four = [target('a-node'), target('b-node'), target('c-node'), target('d-node')];
  const compileBodies = (calls: { path: string; body: unknown }[]): CompileBody[] =>
    calls.filter((c) => c.path === '/internal/compile').map((c) => c.body as CompileBody);
  const asked = (calls: { path: string; body: unknown }[]) =>
    compileBodies(calls).filter((b) => b.modelAllowed !== false);
  const http = (status: number, retryAfterS: number | null = null) =>
    new ApiError(status, 'x', undefined, 'POST /internal/compile', retryAfterS);
  /** The model is out for the day; the cache still has a plan for c-node only. */
  const outForTheDay = (first: unknown) => (b: CompileBody) => {
    if (b.modelAllowed === false)
      return b.toolSlug === 'c-node' ? okReply() : deferred({ reason: 'llm_timeout' });
    if (b.toolSlug === 'a-node') {
      if (first instanceof Error) throw first;
      return first;
    }
    throw new Error('the model must not be asked again: ' + b.toolSlug);
  };

  it.each([
    ['a Retry-After of hours reported as a deferral', deferred({ retryAfterSeconds: 7_200 })],
    ['our own token budget', deferred({ reason: 'llm_budget' })],
    ['an HTTP 429 with a Retry-After of hours', http(429, 7_200)],
  ])(
    '%s: the model is asked once; every later tool gets the cache or its stale plan only, with no wait',
    async (_name, first) => {
      const r = await plan({ real: four, api: { compile: outForTheDay(first) } });
      expect(asked(r.fake.calls).map((b) => b.toolSlug)).toEqual(['a-node']);
      for (const slug of ['b-node', 'c-node', 'd-node']) {
        const mine = compileBodies(r.fake.calls).filter((b) => b.toolSlug === slug);
        expect(mine, slug).toHaveLength(1);
        expect(mine[0]?.modelAllowed, slug).toBe(false);
      }
      expect(r.sleeps).toEqual([]);
      // the cache still serves the tool that has a plan; the others are informational skips, never failures
      expect((await readPlan('c-node')).state).toBe('ready');
      for (const slug of ['a-node', 'b-node', 'd-node'])
        expect((await readPlan(slug)).state, slug).toBe('deferred');
      expect(r.logger.lines.filter((l) => l.msg?.includes('circuit breaker'))).toHaveLength(1);
    },
  );

  it('a short rate limit (a minute-limit) does NOT open the breaker: the next tool still asks the model', async () => {
    const r = await plan({
      real: four,
      api: {
        compile: (b) =>
          b.toolSlug === 'a-node' && b.modelAllowed !== false
            ? deferred({ retryAfterSeconds: 30 })
            : okReply(),
      },
    });
    expect(
      asked(r.fake.calls)
        .map((b) => b.toolSlug)
        .filter((s) => s !== 'a-node'),
    ).toEqual(['b-node', 'c-node', 'd-node']);
    expect(r.logger.lines.some((l) => l.msg?.includes('circuit breaker'))).toBe(false);
  });

  it('an outage with no Retry-After does not open it either (it is not a daily limit)', async () => {
    const r = await plan({
      real: four,
      api: {
        compile: (b) =>
          b.toolSlug === 'a-node' && b.modelAllowed !== false ? deferred() : okReply(),
      },
    });
    expect(asked(r.fake.calls).map((b) => b.toolSlug)).toContain('d-node');
  });

  it('opens in the middle of the run: tools before it keep their model-compiled plans, tools after it are not asked', async () => {
    const r = await plan({
      real: four,
      api: {
        compile: (b) => {
          if (b.modelAllowed === false) return deferred({ reason: 'llm_timeout' });
          return b.toolSlug === 'c-node' ? deferred({ reason: 'llm_budget' }) : okReply();
        },
      },
    });
    expect(asked(r.fake.calls).map((b) => b.toolSlug)).toEqual(['a-node', 'b-node', 'c-node']);
    expect((await readPlan('a-node')).state).toBe('ready');
    expect((await readPlan('b-node')).state).toBe('ready');
    expect((await readPlan('d-node')).state).toBe('deferred');
    expect(r.sleeps).toEqual([]);
  });

  it('keeps the deferral reason of the signal that opened it for the tools it skipped', async () => {
    await plan({
      real: four,
      api: { compile: outForTheDay(deferred({ reason: 'llm_budget' })) },
    });
    expect(await readPlan('d-node')).toMatchObject({ state: 'deferred', reason: 'llm_budget' });
  });

  it('a whole 50-tool run with the model out from the first tool makes one call per tool, no sleeps, and finishes at once', async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      target('tool-' + String(i).padStart(2, '0') + '-node'),
    );
    const r = await plan({
      real: many,
      api: {
        compile: (b) =>
          b.modelAllowed === false
            ? deferred({ reason: 'llm_timeout' })
            : deferred({ retryAfterSeconds: 86_400 }),
      },
    });
    expect(compileBodies(r.fake.calls)).toHaveLength(50); // the first tool asked the model; the 49 others did not
    expect(asked(r.fake.calls)).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
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
