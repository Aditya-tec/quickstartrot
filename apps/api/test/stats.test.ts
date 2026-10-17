import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { FREE_TIER, StatsResponse } from '@qsr/core';
import {
  adminQueueItems,
  docSnapshots,
  incidents,
  llmCalls,
  probeCycles,
  runs,
  stepResults,
  tools,
} from '@qsr/db';
import { resetDb, startTestApp, targetInput, FIXED_NOW, type TestApp } from './helpers.js';

// GET /admin/stats?days=N (P9a): the numbers the 7-day calibration review reads, in one answer, from seeded rows.
// Every figure below can be checked by hand against the seed.

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp(dbUrl as string);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await resetDb(t.handle);
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(FIXED_NOW.getTime() - ms);
const db = () => t.handle.db;

async function seed() {
  const slugs = [
    'alpha-node',
    'beta-node',
    'gamma-python',
    'old-node',
    'canary-pass-node',
    'canary-fail-drift',
  ];
  await t.signed('/internal/targets/sync', {
    targets: slugs.map((s) =>
      targetInput(s, { level: 3, ...(s === 'gamma-python' ? { language: 'python' } : {}) }),
    ),
  });
  await db()
    .update(tools)
    .set({ enabled: false, disabledReason: 'file_removed' })
    .where(eq(tools.slug, 'old-node'));
  await db().update(tools).set({ status: 'DEGRADED' }).where(eq(tools.slug, 'beta-node'));
  const id: Record<string, string> = {};
  for (const row of await db().select().from(tools)) id[row.slug] = row.id;

  const cycle = async (
    startedAgo: number,
    over: Partial<typeof probeCycles.$inferInsert> & { problems?: string[] } = {},
  ) => {
    const { problems, ...rest } = over;
    const [row] = await db()
      .insert(probeCycles)
      .values({
        trigger: 'cron',
        gitSha: 'abcdef1234567',
        startedAt: ago(startedAgo),
        finishedAt: ago(startedAgo - 20 * 60_000),
        canaryOk: true,
        valid: true,
        finishResult: { canaryProblems: problems ?? [] },
        ...rest,
      })
      .returning({ id: probeCycles.id });
    return (row as { id: string }).id;
  };
  const c1 = await cycle(5 * DAY);
  const c2 = await cycle(4 * DAY);
  const c3 = await cycle(3 * DAY);
  const c4 = await cycle(2 * DAY, {
    canaryOk: false,
    valid: false,
    problems: ['canary-pass-node: expected PASS, got FAIL'],
  });
  const c5 = await cycle(1 * DAY);
  await cycle(10 * DAY); // outside a 7 day window
  await cycle(HOUR, { finishedAt: null, valid: null, canaryOk: null, finishResult: null }); // still running

  let n = 0;
  const run = async (
    cycleId: string,
    cycleAgo: number,
    slug: string,
    over: Partial<typeof runs.$inferInsert> = {},
  ) => {
    n += 1;
    const [row] = await db()
      .insert(runs)
      .values({
        cycleId,
        toolId: id[slug] as string,
        attempt: 1,
        outcome: 'PASS',
        reachedLevel: 3,
        imageDigest: 'sha256:' + 'a'.repeat(64),
        runnerEnv: {},
        durationMs: 10_000,
        startedAt: ago(cycleAgo - n * 1000),
        finishedAt: ago(cycleAgo - n * 1000 - 5000),
        ...over,
      })
      .returning({ id: runs.id });
    return (row as { id: string }).id;
  };

  // alpha: steady
  for (const [c, a] of [
    [c1, 5],
    [c2, 4],
    [c3, 3],
    [c5, 1],
  ] as const)
    await run(c, a * DAY, 'alpha-node', { durationMs: 8_000 + a * 100 });
  await run(c4, 2 * DAY, 'alpha-node', {
    outcome: 'FAIL',
    failureClass: 'API_DRIFT',
    failureSignature: 'ignored-invalid-cycle',
  });
  // beta: flips every cycle; cycle 2 has two attempts (the second is final)
  await run(c1, 5 * DAY, 'beta-node', { durationMs: 20_000 });
  await run(c2, 4 * DAY, 'beta-node', {
    outcome: 'FAIL',
    failureClass: 'NETWORK_TRANSIENT',
    failureSignature: 's1',
    attempt: 1,
  });
  const betaFail = await run(c2, 4 * DAY, 'beta-node', {
    outcome: 'FAIL',
    failureClass: 'API_DRIFT',
    failureSignature: 's2',
    attempt: 2,
    durationMs: 40_000,
  });
  await run(c3, 3 * DAY, 'beta-node', { durationMs: 20_000 });
  await run(c5, 1 * DAY, 'beta-node', {
    outcome: 'FAIL',
    failureClass: 'API_DRIFT',
    failureSignature: 's2',
    durationMs: 30_000,
  });
  // gamma: a harness error, a pass on a stale plan, an UNKNOWN failure with evidence in the step output, a pre-flight run
  await run(c1, 5 * DAY, 'gamma-python', {
    outcome: 'HARNESS_ERROR',
    failureClass: 'HARNESS_ERROR',
    reachedLevel: 0,
  });
  await run(c2, 4 * DAY, 'gamma-python', { runnerEnv: { plan_stale: 'true' } });
  const unknownRun = await run(c3, 3 * DAY, 'gamma-python', {
    outcome: 'FAIL',
    failureClass: 'UNKNOWN',
    failureSignature: 'u1',
    failedStepId: 's2',
    reachedLevel: 2,
  });
  await run(c5, 1 * DAY, 'gamma-python', {
    outcome: 'FAIL',
    failureClass: 'CRAWL_ERROR',
    classifierRule: 'preflight',
    reachedLevel: 0,
    durationMs: 0,
  });
  await db().insert(stepResults).values({
    runId: unknownRun,
    stepId: 's2',
    ordinal: 1,
    kind: 'run',
    outcome: 'FAIL',
    exitCode: 1,
    durationMs: 100,
    stdoutTail: 'starting\n',
    stderrTail: 'Traceback...\n\nweird error: something nobody has seen\n\n',
  });
  // a disabled tool still has history
  await run(c1, 5 * DAY, 'old-node');
  // canaries
  await run(c1, 5 * DAY, 'canary-pass-node');
  await run(c2, 4 * DAY, 'canary-pass-node');
  await run(c4, 2 * DAY, 'canary-pass-node', { outcome: 'FAIL', failureClass: 'API_DRIFT' });
  await run(c1, 5 * DAY, 'canary-fail-drift', { outcome: 'FAIL', failureClass: 'API_DRIFT' });

  // the queue: a model classification and compile deferrals
  await db()
    .insert(adminQueueItems)
    .values([
      {
        reason: 'llm_classified',
        toolId: id['beta-node'] as string,
        runId: betaFail,
        createdAt: ago(4 * DAY),
        detail: {
          failureClass: 'API_DRIFT',
          confidence: 0.82,
          evidenceLine: 'x is not a function',
        },
      },
      {
        reason: 'compile_deferred',
        toolId: id['gamma-python'] as string,
        createdAt: ago(3 * DAY),
        detail: { reason: 'llm_budget' },
      },
      {
        reason: 'compile_deferred',
        toolId: id['gamma-python'] as string,
        createdAt: ago(1 * DAY),
        detail: { reason: 'llm_unavailable' },
      },
    ]);
  // incidents
  await db()
    .insert(incidents)
    .values([
      {
        toolId: id['beta-node'] as string,
        signature: 's2',
        failureClass: 'API_DRIFT',
        state: 'OPEN',
        review: 'CONFIRMED',
        openedAt: ago(1 * DAY),
        confirmedAt: ago(20 * HOUR),
        docsChanged: true,
      },
      {
        toolId: id['alpha-node'] as string,
        signature: 'z',
        failureClass: 'API_DRIFT',
        state: 'RESOLVED',
        review: 'FALSE_POSITIVE',
        openedAt: ago(3 * DAY),
        resolvedAt: ago(2 * DAY),
        docsChanged: false,
      },
      {
        toolId: id['gamma-python'] as string,
        signature: 'u',
        failureClass: 'DOCS_SNIPPET_ERROR',
        state: 'OPEN',
        review: 'PENDING_REVIEW',
        openedAt: ago(2 * HOUR),
        docsChanged: null,
      },
    ]);
  // model calls: two on one day, one failed
  await db()
    .insert(llmCalls)
    .values([
      {
        purpose: 'compile',
        model: 'm',
        tokensIn: 1000,
        tokensOut: 300,
        latencyMs: 900,
        ok: true,
        createdAt: ago(2 * DAY),
      },
      {
        purpose: 'compile',
        model: 'm',
        tokensIn: 2000,
        tokensOut: 400,
        latencyMs: 900,
        ok: true,
        createdAt: ago(2 * DAY + HOUR),
      },
      {
        purpose: 'compile',
        model: 'm',
        tokensIn: null,
        tokensOut: null,
        latencyMs: 100,
        ok: false,
        error: 'rate limited',
        createdAt: ago(2 * DAY + 2 * HOUR),
      },
    ]);
  return { id, betaFail, unknownRun };
}

const stats = async (query = '?days=7') => {
  const res = await t.admin('GET', `/admin/stats${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return StatsResponse.parse(res.json());
};
const tool = (s: Awaited<ReturnType<typeof stats>>, slug: string) => {
  const found = s.tools.find((x) => x.slug === slug);
  expect(found, slug).toBeDefined();
  return found as NonNullable<typeof found>;
};

d('GET /admin/stats', () => {
  it('requires the admin token, and a sane `days`', async () => {
    expect(
      (await t.admin('GET', '/admin/stats', undefined, 'wrong-token-wrong-token-wrong')).statusCode,
    ).toBe(401);
    for (const bad of ['?days=0', '?days=91', '?days=abc', '?days=1.5'])
      expect((await t.admin('GET', `/admin/stats${bad}`)).statusCode, bad).toBe(400);
    expect((await t.admin('GET', '/admin/stats')).statusCode).toBe(200); // defaults to 7
  });

  it('counts the cycles in the window: valid, invalid with the reason, still running; the old one is out', async () => {
    await seed();
    const s = await stats();
    expect(s.days).toBe(7);
    expect(s.cycles).toMatchObject({ total: 6, valid: 4, invalid: 1, unfinished: 1 });
    expect(s.cycles.recent).toHaveLength(6);
    expect(s.cycles.recent[0]).toMatchObject({ valid: null, durationSeconds: null }); // newest: the running one
    const invalid = s.cycles.recent.find((c) => c.valid === false);
    expect(invalid?.problems).toEqual(['canary-pass-node: expected PASS, got FAIL']);
    expect(invalid?.canaryOk).toBe(false);
    const done = s.cycles.recent.find((c) => c.valid === true);
    expect(done?.durationSeconds).toBe(20 * 60);
  });

  it('counts per tool from valid cycles only, final attempts only, and keeps pre-flight runs out of pass and fail', async () => {
    await seed();
    const s = await stats();
    expect(tool(s, 'alpha-node')).toMatchObject({
      pass: 4,
      fail: 0,
      skipped: 0,
      notRun: 0,
      enabled: true,
    });
    expect(tool(s, 'beta-node')).toMatchObject({ pass: 2, fail: 2, status: 'DEGRADED' });
    expect(tool(s, 'gamma-python')).toMatchObject({
      pass: 1,
      fail: 1,
      harnessErrors: 1,
      notRun: 1,
      staleRuns: 1,
      deferred: 2,
    });
    expect(tool(s, 'old-node')).toMatchObject({ enabled: false, pass: 1 });
    expect(s.tools.map((x) => x.slug)).not.toContain('canary-pass-node');
  });

  it('gives a flake score, and flags the tool that flips every cycle', async () => {
    await seed();
    const s = await stats();
    expect(tool(s, 'beta-node')).toMatchObject({ flakeScore: 1, flipping: true });
    expect(tool(s, 'alpha-node')).toMatchObject({ flakeScore: 0, flipping: false });
  });

  it('computes the harness error rate overall and per day, over real tools that ran', async () => {
    await seed();
    const s = await stats();
    // finals of real tools, excluding the pre-flight run: 5 days ago 4 (alpha, beta, gamma, old), 4 days ago 3, 3 days ago 3,
    // 2 days ago 1 (alpha in the invalid cycle), 1 day ago 2 (alpha, beta)
    expect(s.harness.overall).toEqual({ runs: 13, errors: 1, rate: 1 / 13 });
    const day = (offset: number) =>
      new Date(FIXED_NOW.getTime() - offset * DAY).toISOString().slice(0, 10);
    expect(s.harness.byDay.find((x) => x.day === day(5))).toMatchObject({ runs: 4, errors: 1 });
    expect(s.harness.byDay.find((x) => x.day === day(4))).toMatchObject({ runs: 3, errors: 0 });
    expect(s.harness.byDay.map((x) => x.day)).toEqual(
      [...s.harness.byDay.map((x) => x.day)].sort(),
    );
  });

  it('lists every UNKNOWN failure with the last line of its output as evidence', async () => {
    const { unknownRun } = await seed();
    const s = await stats();
    expect(s.unknowns).toHaveLength(1);
    expect(s.unknowns[0]).toMatchObject({
      runId: unknownRun,
      slug: 'gamma-python',
      failedStepId: 's2',
      evidenceLine: 'weird error: something nobody has seen',
    });
  });

  it('lists the model classifications with their confidence and evidence', async () => {
    const { betaFail } = await seed();
    const s = await stats();
    expect(s.llmClassified).toEqual([
      expect.objectContaining({
        runId: betaFail,
        slug: 'beta-node',
        failureClass: 'API_DRIFT',
        confidence: 0.82,
        evidenceLine: 'x is not a function',
      }),
    ]);
  });

  it('summarises compile deferrals, stale-plan runs and the model calls', async () => {
    await seed();
    const s = await stats();
    expect(s.compile.deferrals).toEqual([
      { slug: 'gamma-python', count: 2, reasons: { llm_budget: 1, llm_unavailable: 1 } },
    ]);
    expect(s.compile.staleRuns).toBe(1);
    expect(s.compile.llm).toEqual({ calls: 3, failedCalls: 1, tokensIn: 3000, tokensOut: 700 });
  });

  it('counts the distinct content hashes each tool had in the window and flags 3 or more (a page that will not hold still)', async () => {
    const { id } = await seed();
    const snap = (slug: string, n: number, lastSeenAgo: number) =>
      db()
        .insert(docSnapshots)
        .values({
          toolId: id[slug] as string,
          contentHash: slug.slice(0, 3) + String(n).padStart(61, '0'),
          extraction: { blocks: [] },
          firstSeenAt: ago(lastSeenAgo + HOUR),
          lastSeenAt: ago(lastSeenAgo),
        });
    await snap('alpha-node', 1, 2 * DAY); // one hash: steady
    await snap('alpha-node', 2, 12 * DAY); // seen last 12 days ago: outside the window
    for (const n of [1, 2, 3, 4]) await snap('beta-node', n, n * DAY - 2 * HOUR); // four hashes: flagged
    for (const n of [1, 2]) await snap('gamma-python', n, n * HOUR); // two: listed, not flagged
    for (const n of [1, 2, 3]) await snap('canary-pass-node', n, n * HOUR); // canaries are not pages
    const s = await stats();
    expect(s.compile.hashChurn).toEqual({
      flagAt: 3,
      tools: [
        { slug: 'beta-node', distinctHashes: 4, flagged: true },
        { slug: 'gamma-python', distinctHashes: 2, flagged: false },
      ],
    });
    // a smaller window counts fewer: only beta's hashes last seen 22 and 46 hours ago are inside 2 days
    expect((await stats('?days=2')).compile.hashChurn.tools).toEqual([
      { slug: 'beta-node', distinctHashes: 2, flagged: false },
      { slug: 'gamma-python', distinctHashes: 2, flagged: false },
    ]);
  });

  it('counts incidents by state and review, and lists them', async () => {
    await seed();
    const s = await stats();
    expect(s.incidents).toMatchObject({
      open: 2,
      resolved: 1,
      confirmed: 1,
      falsePositive: 1,
      pendingReview: 1,
    });
    expect(s.incidents.list).toHaveLength(3);
  });

  it('judges each canary against what it must do, and shows the mismatch that invalidated a cycle', async () => {
    await seed();
    const s = await stats();
    const pass = s.canaries.find((c) => c.slug === 'canary-pass-node');
    expect(pass).toMatchObject({ runs: 3, expected: 'PASS', matched: 2, mismatched: 1 });
    expect(s.canaries.find((c) => c.slug === 'canary-fail-drift')).toMatchObject({
      expected: 'FAIL',
      matched: 1,
      mismatched: 0,
    });
  });

  it('ranks the slowest tools by median duration', async () => {
    await seed();
    const s = await stats();
    expect(s.slowest[0]).toMatchObject({ slug: 'beta-node', maxDurationMs: 40_000 });
    expect(s.slowest.length).toBeLessThanOrEqual(10);
    expect(s.slowest.every((x) => x.medianDurationMs > 0)).toBe(true);
  });

  it('sums the model tokens per day', async () => {
    await seed();
    const s = await stats();
    const day = new Date(FIXED_NOW.getTime() - 2 * DAY).toISOString().slice(0, 10);
    expect(s.groq.find((g) => g.day === day)).toEqual({
      day,
      calls: 3,
      failedCalls: 1,
      tokens: 3700,
    });
  });

  it('reports storage against the free tier: the database, its biggest tables, and Storage when it can be seen', async () => {
    await seed();
    const s = await stats();
    expect(s.storage.database.bytes).toBeGreaterThan(0);
    expect(s.storage.database.limitBytes).toBe(FREE_TIER.databaseBytes);
    expect(s.storage.database.percent).toBeCloseTo(
      (s.storage.database.bytes / FREE_TIER.databaseBytes) * 100,
      5,
    );
    expect(s.storage.tables.some((x) => x.name === 'runs')).toBe(true);
    // a plain Postgres has no storage schema: the answer says so instead of failing
    expect(s.storage.objects).toBeNull();
  });

  it('a smaller window leaves out older data', async () => {
    await seed();
    const s = await stats('?days=2');
    expect(s.cycles.total).toBe(3); // the invalid one (2 days ago, inside), the 1 day one, the running one
    expect(tool(s, 'alpha-node').pass).toBe(1);
    expect(s.llmClassified).toHaveLength(0);
  });

  it('an empty database gives a valid, empty answer', async () => {
    const s = await stats();
    expect(s.cycles.total).toBe(0);
    expect(s.tools).toEqual([]);
    expect(s.harness.overall).toEqual({ runs: 0, errors: 0, rate: 0 });
  });

  it('is read-only: asking changes nothing', async () => {
    await seed();
    const before = (await db().select().from(runs)).length;
    await stats();
    expect((await db().select().from(runs)).length).toBe(before);
  });
});
