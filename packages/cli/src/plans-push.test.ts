import { describe, expect, it } from 'vitest';
import { COMPILER_VERSION, createMemoryCache, type CompiledPlan } from '@qsr/compiler';
import { CrawlError } from '@qsr/crawler';
import { PlanImportBody, type Extraction, type Target } from '@qsr/core';
import { ApiError } from './api-client.js';
import { runPlansPush, type PlansPushDeps } from './plans-push.js';
import { HASH, extractionFor, ir, recordingLogger, target } from './probe/probe.test-utils.js';

// `qsr plans push` (P9a): a plan compiled on this machine (the local file cache, filled by `qsr compile` or `qsr run`)
// is sent to POST /admin/plans/import, so the production plan job finds it in the plan cache and spends no model
// tokens on it. The page is crawled once, now, because the plan is only useful for the page as it is today.

const A = target('a-node');
const B = target('b-node');
const C = target('c-node');

function plan(t: Target, over: Partial<CompiledPlan> = {}): CompiledPlan {
  return {
    toolSlug: t.slug,
    contentHash: HASH,
    compilerVersion: COMPILER_VERSION,
    model: 'openai/gpt-oss-120b',
    ir: ir(t.slug),
    groundingReport: { ok: true, violations: [] },
    accepted: true,
    truncation: {
      truncated: false,
      totalBlocks: 1,
      includedBlocks: 1,
      omittedBlocks: 0,
      omittedBlockIndexes: [],
      clippedBlockIndexes: [],
    },
    createdAt: '2026-10-17T12:00:00.000Z',
    ...over,
  };
}

interface Harness {
  deps: PlansPushDeps;
  posts: { path: string; body: unknown }[];
  crawled: string[];
}

async function harness(
  opts: {
    plans?: CompiledPlan[];
    crawl?: (t: Target) => Promise<Extraction>;
    post?: (path: string, body: unknown) => unknown;
  } = {},
): Promise<Harness> {
  const cache = createMemoryCache();
  for (const p of opts.plans ?? []) await cache.put(p);
  const posts: Harness['posts'] = [];
  const crawled: string[] = [];
  const deps: PlansPushDeps = {
    api: {
      wakeApi: async () => ({ attempts: 1, waitedMs: 0 }),
      get: (async () => ({})) as PlansPushDeps['api']['get'],
      post: (async (path: string, body: unknown) => {
        posts.push({ path, body });
        if (opts.post) return opts.post(path, body);
        return {
          status: 'imported',
          planId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          contentHash: HASH,
          configHash: 'c'.repeat(64),
          compilerVersion: COMPILER_VERSION,
        };
      }) as PlansPushDeps['api']['post'],
    },
    cache,
    crawl:
      opts.crawl ??
      (async (t) => {
        crawled.push(t.slug);
        return extractionFor(t);
      }),
    log: recordingLogger(),
  };
  return { deps, posts, crawled };
}

describe('runPlansPush', () => {
  it('crawls the page, finds the plan for exactly that page, and imports it with the target and the extraction', async () => {
    const h = await harness({ plans: [plan(A)] });
    const [r] = await runPlansPush({ targets: [A], dryRun: false }, h.deps);
    expect(r).toMatchObject({ slug: 'a-node', status: 'imported' });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.path).toBe('/admin/plans/import');
    const body = PlanImportBody.parse(h.posts[0]?.body);
    expect(body.target.slug).toBe('a-node');
    expect(body.extraction.contentHash).toBe(HASH);
    expect(body.plan).toMatchObject({
      contentHash: HASH,
      compilerVersion: COMPILER_VERSION,
      model: 'openai/gpt-oss-120b',
    });
    expect(h.crawled).toEqual(['a-node']);
  });

  it('says so when the server already has the plan', async () => {
    const h = await harness({
      plans: [plan(A)],
      post: () => ({
        status: 'already_present',
        planId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        contentHash: HASH,
        configHash: 'c'.repeat(64),
        compilerVersion: COMPILER_VERSION,
      }),
    });
    expect((await runPlansPush({ targets: [A], dryRun: false }, h.deps))[0]?.status).toBe(
      'already_present',
    );
  });

  it('a target with no plan on this machine is reported, not sent, and does not stop the others', async () => {
    const h = await harness({ plans: [plan(B)] });
    const results = await runPlansPush({ targets: [A, B], dryRun: false }, h.deps);
    expect(results.map((r) => [r.slug, r.status])).toEqual([
      ['a-node', 'no_local_plan'],
      ['b-node', 'imported'],
    ]);
    expect(results[0]?.detail).toMatch(/qsr compile|qsr run/);
    expect(h.posts).toHaveLength(1);
  });

  it('a plan for an OLDER version of the page is not sent: the content hash must match the page as crawled now', async () => {
    const h = await harness({ plans: [plan(A, { contentHash: 'b'.repeat(64) })] });
    expect((await runPlansPush({ targets: [A], dryRun: false }, h.deps))[0]?.status).toBe(
      'no_local_plan',
    );
    expect(h.posts).toHaveLength(0);
  });

  it('a plan compiled by another compiler version is not sent either', async () => {
    const h = await harness({ plans: [plan(A, { compilerVersion: '2000-01-01.1' })] });
    expect((await runPlansPush({ targets: [A], dryRun: false }, h.deps))[0]?.status).toBe(
      'no_local_plan',
    );
  });

  it('a locally REJECTED plan is never sent', async () => {
    const h = await harness({ plans: [plan(A, { accepted: false, ir: null })] });
    const [r] = await runPlansPush({ targets: [A], dryRun: false }, h.deps);
    expect(r?.status).toBe('no_local_plan');
    expect(r?.detail).toMatch(/rejected/i);
    expect(h.posts).toHaveLength(0);
  });

  it('a crawl failure is reported for that target only', async () => {
    const h = await harness({
      plans: [plan(A), plan(B)],
      crawl: async (t) => {
        if (t.slug === 'a-node')
          throw new CrawlError('http_status', 'docs page returned HTTP 404', { httpStatus: 404 });
        return extractionFor(t);
      },
    });
    const results = await runPlansPush({ targets: [A, B], dryRun: false }, h.deps);
    expect(results.map((r) => r.status)).toEqual(['crawl_failed', 'imported']);
    expect(results[0]?.detail).toContain('404');
  });

  it('the server refusing a plan (a 4xx) is reported with its reason, and the next target goes on', async () => {
    let n = 0;
    const h = await harness({
      plans: [plan(A), plan(B)],
      post: () => {
        if (n++ === 0)
          throw new ApiError(
            422,
            'Unprocessable Entity',
            'The plan failed the grounding validator: s1 command',
            'POST /admin/plans/import',
          );
        return {
          status: 'imported',
          planId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          contentHash: HASH,
          configHash: 'c'.repeat(64),
          compilerVersion: COMPILER_VERSION,
        };
      },
    });
    const results = await runPlansPush({ targets: [A, B], dryRun: false }, h.deps);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'imported']);
    expect(results[0]?.detail).toContain('grounding validator');
  });

  it('a 401 stops everything at once: no point trying the other targets with a wrong token', async () => {
    const h = await harness({
      plans: [plan(A), plan(B)],
      post: () => {
        throw new ApiError(
          401,
          'Unauthorized',
          'A valid admin token is required.',
          'POST /admin/plans/import',
        );
      },
    });
    await expect(runPlansPush({ targets: [A, B], dryRun: false }, h.deps)).rejects.toThrow(
      /admin token/i,
    );
    expect(h.posts).toHaveLength(1);
  });

  it('--dry-run crawls and checks but sends nothing', async () => {
    const h = await harness({ plans: [plan(A)] });
    const [r] = await runPlansPush({ targets: [A], dryRun: true }, h.deps);
    expect(r?.status).toBe('would_push');
    expect(h.posts).toHaveLength(0);
  });

  it('crawls each page once, one after another (politeness), in the order given', async () => {
    const order: string[] = [];
    let active = 0;
    let max = 0;
    const h = await harness({
      plans: [plan(A), plan(B), plan(C)],
      crawl: async (t) => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push(t.slug);
        active -= 1;
        return extractionFor(t);
      },
    });
    await runPlansPush({ targets: [A, B, C], dryRun: false }, h.deps);
    expect(order).toEqual(['a-node', 'b-node', 'c-node']);
    expect(max).toBe(1);
  });
});
