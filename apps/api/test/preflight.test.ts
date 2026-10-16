import { and, eq } from 'drizzle-orm';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { adminQueueItems, incidents, runs, stepResults, tools } from '@qsr/db';
import { RUNNER_ENV_KEYS, type PreflightFailure, type RunResult } from '@qsr/core';
import { resetDb, startTestApp, type TestApp } from './helpers.js';
import { docsExtraction, garbagePlanJson, runResult, step } from './fixtures.js';
import {
  BASE,
  DAY,
  at,
  canaryResults,
  fail,
  finishCycle,
  newCycle,
  pass,
  postRuns,
  stamp,
  syncTools,
  toolRow,
} from './cycle-helpers.js';

// P7 pre-flight: a tool whose crawl or compile failed never reaches the executor, but the cycle still
// records it (a run with the failure class, no steps) so the history and the step summary show it.
// CRAWL_ERROR and COMPILER_ERROR never change a status and never open an incident (spec section 10).
// A run that used a STALE plan (the model was not asked) is not evidence against the vendor either.

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
  t.llm.reset();
  t.fetchCalls.length = 0;
  t.fetchReplies.length = 0;
  t.clock.now = new Date(BASE);
});

const crawl: PreflightFailure = {
  stage: 'crawl',
  failureClass: 'CRAWL_ERROR',
  reason: 'no_code_blocks',
  message: 'the page has no code blocks',
};
const compiler: PreflightFailure = {
  stage: 'compile',
  failureClass: 'COMPILER_ERROR',
  reason: 'rejected_twice',
  message: 'the plan failed the grounding validator twice',
};

/** The synthetic RunResult `qsr report` sends beside a preflight object. */
function preflightRun(cycleId: string, time: string, over: Partial<RunResult> = {}): RunResult {
  return stamp(
    runResult({
      cycleId,
      toolSlug: 'acme-node',
      outcome: 'FAIL',
      reachedLevel: 0,
      failedStepId: null,
      steps: [],
      imageDigest: 'none',
      runnerEnv: {},
      ...over,
    }),
    time,
  );
}
const postPreflight = (run: RunResult, preflight: PreflightFailure) =>
  t.signed('/internal/runs', { runResult: run, logPaths: {}, preflight });
const queue = (reason: string) =>
  t.handle.db.select().from(adminQueueItems).where(eq(adminQueueItems.reason, reason));

d('ingesting a pre-flight failure', () => {
  it('stores a run with the failure class, a stable signature, no steps and no model call', async () => {
    await syncTools(t, 'acme-node');
    const cycleId = await newCycle(t, 0);
    const res = await postPreflight(preflightRun(cycleId, at(0, 1)), crawl);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().created).toBe(true);
    expect(res.json().classification).toMatchObject({
      failureClass: 'CRAWL_ERROR',
      ruleId: 'preflight',
      signature: 'CRAWL_ERROR:no_code_blocks',
      source: 'rule',
    });
    const [row] = await t.handle.db.select().from(runs).where(eq(runs.cycleId, cycleId));
    expect(row).toMatchObject({
      outcome: 'FAIL',
      failureClass: 'CRAWL_ERROR',
      failureSignature: 'CRAWL_ERROR:no_code_blocks',
      classifierRule: 'preflight',
      reachedLevel: 0,
    });
    expect(await t.handle.db.select().from(stepResults)).toHaveLength(0);
    expect(t.llm.calls).toBe(0);
  });

  it('a compile failure keeps the rejected plan id that the compile endpoint stored', async () => {
    await syncTools(t, 'acme-node');
    const cycleId = await newCycle(t, 0);
    t.llm.push(garbagePlanJson(), garbagePlanJson());
    const compiled = (
      await t.signed('/internal/compile', {
        cycleId,
        toolSlug: 'acme-node',
        extraction: docsExtraction(),
      })
    ).json();
    expect(compiled.status).toBe('compiler_error');
    const res = await postPreflight(
      preflightRun(cycleId, at(0, 1), {
        planId: compiled.plan.id,
        snapshotHash: compiled.plan.contentHash,
      }),
      compiler,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().classification.failureClass).toBe('COMPILER_ERROR');
    const [row] = await t.handle.db.select().from(runs).where(eq(runs.cycleId, cycleId));
    expect(row?.planId).toBe(compiled.plan.id);
  });

  it('is idempotent on (cycle, tool, attempt)', async () => {
    await syncTools(t, 'acme-node');
    const cycleId = await newCycle(t, 0);
    const run = preflightRun(cycleId, at(0, 1));
    const a = await postPreflight(run, crawl);
    const b = await postPreflight(run, crawl);
    expect(a.json().created).toBe(true);
    expect(b.json().created).toBe(false);
    expect(await t.handle.db.select().from(runs)).toHaveLength(1);
  });

  it.each([
    ['a run that has steps', { steps: [step('s1', 0, 'shell')] }],
    ['an outcome other than FAIL', { outcome: 'PASS' as const }],
    ['a reached level above 0', { reachedLevel: 2 }],
    ['a failed step', { failedStepId: 's1' }],
  ])('refuses %s: a pre-flight failure never executed anything', async (_name, over) => {
    await syncTools(t, 'acme-node');
    const cycleId = await newCycle(t, 0);
    const res = await postPreflight(
      preflightRun(cycleId, at(0, 1), over as Partial<RunResult>),
      crawl,
    );
    expect(res.statusCode).toBe(400);
    expect(await t.handle.db.select().from(runs)).toHaveLength(0);
  });

  it('the failure class of a run is the preflight one, whatever the runner calls it', async () => {
    await syncTools(t, 'acme-node');
    const cycleId = await newCycle(t, 0);
    const res = await postPreflight(preflightRun(cycleId, at(0, 1)), {
      ...crawl,
      failureClass: 'COMPILER_ERROR',
      stage: 'compile',
    });
    expect(res.json().classification.failureClass).toBe('COMPILER_ERROR');
  });
});

d('cycle finish with pre-flight failures', () => {
  async function healthyThen(day: number, slug = 'acme-node') {
    await syncTools(t, slug);
    const cycleId = await newCycle(t, day);
    const time = at(day, 1);
    await postRuns(t, [...canaryResults(cycleId, time), pass(cycleId, slug, time)]);
    expect((await finishCycle(t, cycleId)).statusCode).toBe(200);
    expect((await toolRow(t, slug))?.status).toBe('HEALTHY');
  }

  it('CRAWL_ERROR leaves the status as it was, opens no incident, and queues ONE item', async () => {
    await healthyThen(0);
    const cycleId = await newCycle(t, 1);
    const time = at(1, 1);
    // what `qsr plan` did at crawl time: told the compile endpoint, which queued an item
    await t.signed('/internal/compile', {
      cycleId,
      toolSlug: 'acme-node',
      crawlError: { reason: crawl.reason, message: crawl.message },
    });
    await postRuns(t, canaryResults(cycleId, time));
    await postPreflight(preflightRun(cycleId, time), crawl);
    const res = await finishCycle(t, cycleId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().valid).toBe(true);
    const row = await toolRow(t, 'acme-node');
    expect(row).toMatchObject({ status: 'HEALTHY', consecutiveFailures: 0 });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    // the compile endpoint's item and the engine's event are one problem, not two
    expect(await queue('crawl_error')).toHaveLength(1);
  });

  it('COMPILER_ERROR likewise, and twice in a row still opens nothing', async () => {
    await healthyThen(0);
    for (const day of [1, 2]) {
      const cycleId = await newCycle(t, day);
      const time = at(day, 1);
      await postRuns(t, canaryResults(cycleId, time));
      await postPreflight(preflightRun(cycleId, time), compiler);
      expect((await finishCycle(t, cycleId)).statusCode).toBe(200);
    }
    expect(await toolRow(t, 'acme-node')).toMatchObject({
      status: 'HEALTHY',
      consecutiveFailures: 0,
    });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    expect((await queue('compiler_error')).length).toBeGreaterThanOrEqual(1);
  });

  it('a pre-flight failure in an INVALID cycle changes nothing either', async () => {
    await healthyThen(0);
    const cycleId = await newCycle(t, 1);
    const time = at(1, 1);
    const wrong = canaryResults(cycleId, time).map((r) =>
      r.toolSlug === 'canary-pass-node' ? fail(cycleId, 'canary-pass-node', 'boom', time) : r,
    );
    await postRuns(t, wrong);
    await postPreflight(preflightRun(cycleId, time), crawl);
    expect((await finishCycle(t, cycleId)).json().valid).toBe(false);
    expect((await toolRow(t, 'acme-node'))?.status).toBe('HEALTHY');
  });
});

d('a run that used a stale plan', () => {
  const STALE = { [RUNNER_ENV_KEYS.planStale]: 'true' };
  const REAL_FAILURE =
    'TypeError: acme.send is not a function\n    at Object.<anonymous> (/work/index.js:3:6)\n';

  async function cycleWith(day: number, results: (c: string, time: string) => RunResult[]) {
    const cycleId = await newCycle(t, day);
    const time = at(day, 1);
    await postRuns(t, [...canaryResults(cycleId, time), ...results(cycleId, time)]);
    return finishCycle(t, cycleId);
  }

  it('a PASS with a stale plan counts as a pass (it ran, and it worked)', async () => {
    await syncTools(t, 'acme-node');
    await cycleWith(0, (c, time) => [pass(c, 'acme-node', time, { runnerEnv: STALE })]);
    expect((await toolRow(t, 'acme-node'))?.status).toBe('HEALTHY');
  });

  it('a FAIL with a stale plan is not a vendor failure: no streak, no incident, a queue item', async () => {
    await syncTools(t, 'acme-node');
    await cycleWith(0, (c, time) => [pass(c, 'acme-node', time)]);
    for (const day of [1, 2, 3]) {
      const res = await cycleWith(day, (c, time) => [
        fail(c, 'acme-node', REAL_FAILURE, time, { runnerEnv: STALE }),
      ]);
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await toolRow(t, 'acme-node')).toMatchObject({
      status: 'HEALTHY',
      consecutiveFailures: 0,
    });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    const items = await queue('compiler_error');
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(items[0]?.detail)).toMatch(/stale/);
  });

  it('the same failure with a CURRENT plan still counts (control)', async () => {
    await syncTools(t, 'acme-node');
    await cycleWith(0, (c, time) => [pass(c, 'acme-node', time)]);
    await cycleWith(1, (c, time) => [fail(c, 'acme-node', REAL_FAILURE, time)]);
    expect((await toolRow(t, 'acme-node'))?.consecutiveFailures).toBe(1);
  });

  it('the stored run keeps its true failure class (only the engine input is neutralised)', async () => {
    await syncTools(t, 'acme-node');
    await cycleWith(0, (c, time) => [
      fail(c, 'acme-node', REAL_FAILURE, time, { runnerEnv: STALE }),
    ]);
    const [row] = await t.handle.db
      .select()
      .from(runs)
      .innerJoin(tools, eq(tools.id, runs.toolId))
      .where(and(eq(tools.slug, 'acme-node')));
    expect(row?.runs.failureClass).toBe('API_DRIFT');
  });
});

d('GET /internal/cycles: tool durations for sharding', () => {
  it('lastDurationMs is null for a tool that never ran and the final attempt duration after it did', async () => {
    await syncTools(t, 'acme-node');
    const first = (
      await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1' })
    ).json();
    expect(
      first.tools.every((x: { lastDurationMs: number | null }) => x.lastDurationMs === null),
    ).toBe(true);

    const cycleId = first.cycleId as string;
    await postRuns(t, [pass(cycleId, 'acme-node', at(0, 1))]);
    await finishCycle(t, cycleId);
    t.clock.now = new Date(BASE + DAY);
    const second = (
      await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1', ghRunId: 9 })
    ).json();
    const acme = second.tools.find((x: { slug: string }) => x.slug === 'acme-node');
    expect(acme.lastDurationMs).toBe(5000);
  });
});

d('canaries are tools, and never public', () => {
  const anon = async <T>(query: ReturnType<typeof dsql>): Promise<T[]> =>
    t.handle.db.transaction(async (tx) => {
      await tx.execute(dsql`set local role anon`);
      return (await tx.execute(query)) as unknown as T[];
    });

  it('syncing targets/_canary/* creates tools flagged is_canary; real tools are not', async () => {
    await syncTools(t, 'acme-node');
    const rows = await t.handle.db.select().from(tools);
    expect(
      rows
        .filter((r) => r.isCanary)
        .map((r) => r.slug)
        .sort(),
    ).toEqual(['canary-fail-dep', 'canary-fail-drift', 'canary-pass-node', 'canary-pass-python']);
    expect(rows.find((r) => r.slug === 'acme-node')?.isCanary).toBe(false);
  });

  it('an anon query returns no canary from public_tools, public_runs or public_incidents', async () => {
    await syncTools(t, 'acme-node');
    const cycleId = await newCycle(t, 0);
    const time = at(0, 1);
    await postRuns(t, [...canaryResults(cycleId, time), pass(cycleId, 'acme-node', time)]);
    expect((await finishCycle(t, cycleId)).json().valid).toBe(true);

    // even a CONFIRMED incident on a canary must stay out of the public view
    const [canary] = await t.handle.db
      .select()
      .from(tools)
      .where(eq(tools.slug, 'canary-fail-drift'));
    await t.handle.db.insert(incidents).values({
      toolId: (canary as { id: string }).id,
      signature: 'x',
      failureClass: 'API_DRIFT',
      review: 'CONFIRMED',
    });

    const publicTools = await anon<{ slug: string }>(dsql`select slug from public_tools`);
    const publicRuns = await anon<{ tool_slug: string }>(dsql`select tool_slug from public_runs`);
    const publicIncidents = await anon<{ tool_slug: string }>(
      dsql`select tool_slug from public_incidents`,
    );
    expect(publicTools.map((r) => r.slug)).toEqual(['acme-node']);
    expect(publicRuns.map((r) => r.tool_slug)).toEqual(['acme-node']);
    expect(publicIncidents).toEqual([]);
    for (const rows of [publicTools, publicRuns, publicIncidents])
      expect(JSON.stringify(rows)).not.toContain('canary');
  });

  it('anon cannot read the base tables at all', async () => {
    await syncTools(t, 'acme-node');
    for (const table of [dsql`select * from tools`, dsql`select * from runs`])
      await expect(anon(table)).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/permission denied/) },
      });
  });
});

d('the public pass rate ignores runs that never reached the executor', () => {
  const anonRate = async (): Promise<string | null> =>
    t.handle.db.transaction(async (tx) => {
      await tx.execute(dsql`set local role anon`);
      const rows = (await tx.execute(
        dsql`select pass_rate_30d from public_tools where slug = 'acme-node'`,
      )) as unknown as { pass_rate_30d: string | null }[];
      return rows[0]?.pass_rate_30d ?? null;
    });

  it('a tool with one PASS and two CRAWL_ERRORs has a pass rate of 1, not one third', async () => {
    await syncTools(t, 'acme-node');
    const days = [0, 1, 2];
    for (const day of days) {
      const cycleId = await newCycle(t, day);
      const time = at(day, 1);
      await postRuns(t, canaryResults(cycleId, time));
      if (day === 0) await postRuns(t, [pass(cycleId, 'acme-node', time)]);
      else await postPreflight(preflightRun(cycleId, time), crawl);
      await finishCycle(t, cycleId);
    }
    t.clock.now = new Date(BASE + 3 * DAY);
    expect(Number(await anonRate())).toBe(1);
  });

  it('a tool with only pre-flight failures has no pass rate yet (null, not 0)', async () => {
    await syncTools(t, 'acme-node');
    const cycleId = await newCycle(t, 0);
    await postRuns(t, canaryResults(cycleId, at(0, 1)));
    await postPreflight(preflightRun(cycleId, at(0, 1)), compiler);
    await finishCycle(t, cycleId);
    expect(await anonRate()).toBeNull();
  });
});
