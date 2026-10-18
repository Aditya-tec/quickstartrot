import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { adminQueueItems, incidents, runs, stepResults, tools } from '@qsr/db';
import type { RunResult, ShadowExportCheck } from '@qsr/core';
import { resetDb, startTestApp, type TestApp } from './helpers.js';
import { DRIFT_STDERR, step } from './fixtures.js';
import {
  at,
  canaryResults,
  fail,
  finishCycle,
  newCycle,
  pass,
  postRuns,
  syncTools,
  toolRow,
} from './cycle-helpers.js';

// P9d. The harness has a version. Everything recorded before it is version 1; the checks that ship with P9d are version 2.
//   1. the version is stored on every run and step, and a run from a runner that predates it is version 1;
//   2. the status engine never counts failures under different versions as consecutive, through the real ingest and finish flow;
//   3. a version bump alone moves no status;
//   4. shadow mode (the export check's answer) is stored and NOTHING reads it: no classification, status, queue item, incident or
//      public view changes because of it.

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
  t.clock.now = new Date(at(0));
});

const v = (harnessVersion: number): Partial<RunResult> => ({ harnessVersion });

/** One valid cycle on `day`: the canaries behave and these results are reported. */
async function cycle(day: number, results: (cycleId: string, time: string) => RunResult[]) {
  const cycleId = await newCycle(t, day);
  const time = at(day, 1);
  await postRuns(t, [...canaryResults(cycleId, time), ...results(cycleId, time)]);
  t.clock.now = new Date(Date.parse(time) + 60_000);
  const res = await finishCycle(t, cycleId);
  expect(res.statusCode, res.body).toBe(200);
  return { cycleId, finished: res.json() };
}

const failing =
  (slug: string, version: number, stderr = DRIFT_STDERR) =>
  (c: string, time: string) => [fail(c, slug, stderr, time, v(version))];
const passing = (slug: string, version: number) => (c: string, time: string) => [
  pass(c, slug, time, v(version)),
];

d('the harness version is stored on every run and step', () => {
  it('stores version 2 from a v2 runner, and version 1 for a runner that predates versioning (the field is absent)', async () => {
    await syncTools(t, 'acme-node', 'old-node');
    const cycleId = await newCycle(t, 0);
    const time = at(0, 1);
    const old = pass(cycleId, 'old-node', time);
    delete (old as Partial<RunResult>).harnessVersion; // what a runner built before P9d sends
    await postRuns(t, [
      ...canaryResults(cycleId, time),
      pass(cycleId, 'acme-node', time, v(2)),
      old,
    ]);
    const rows = await t.handle.db.select().from(runs);
    const by = async (slug: string) => {
      const [tool] = await t.handle.db.select().from(tools).where(eq(tools.slug, slug));
      return rows.find((r) => r.toolId === tool?.id);
    };
    expect((await by('acme-node'))?.harnessVersion).toBe(2);
    expect((await by('old-node'))?.harnessVersion).toBe(1);
    const steps = await t.handle.db.select().from(stepResults);
    const newRun = await by('acme-node');
    expect(steps.filter((s) => s.runId === newRun?.id).every((s) => s.harnessVersion === 2)).toBe(
      true,
    );
  });

  it('shows it on the run page data, and nothing else about the harness', async () => {
    await syncTools(t, 'acme-node');
    const { cycleId } = await cycle(0, passing('acme-node', 2));
    const sql = t.handle.sql;
    const rows =
      await sql`select harness_version from public_runs where tool_slug = 'acme-node' and cycle_id = ${cycleId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.harness_version).toBe(2);
  });
});

d(
  'failures under different harness versions are never consecutive (through ingest and finish)',
  () => {
    it('v1 then v1: BROKEN with an incident (the control, unchanged behaviour)', async () => {
      await syncTools(t, 'acme-node');
      await cycle(0, failing('acme-node', 1));
      await cycle(1, failing('acme-node', 1));
      expect(await toolRow(t, 'acme-node')).toMatchObject({
        status: 'BROKEN',
        consecutiveFailures: 2,
      });
      expect(await t.handle.db.select().from(incidents)).toHaveLength(1);
    });

    it('v1 then the same failure under v2: DEGRADED, no incident; two under v2 open it', async () => {
      await syncTools(t, 'acme-node');
      await cycle(0, failing('acme-node', 1));
      expect(await toolRow(t, 'acme-node')).toMatchObject({
        status: 'DEGRADED',
        lastFailureHarnessVersion: 1,
      });
      const second = await cycle(1, failing('acme-node', 2));
      expect(second.finished.tools[0]).toMatchObject({
        slug: 'acme-node',
        before: 'DEGRADED',
        after: 'DEGRADED',
        events: [],
      });
      expect(await toolRow(t, 'acme-node')).toMatchObject({
        status: 'DEGRADED',
        consecutiveFailures: 1,
        lastFailureHarnessVersion: 2,
      });
      expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
      await cycle(2, failing('acme-node', 2));
      expect(await toolRow(t, 'acme-node')).toMatchObject({
        status: 'BROKEN',
        consecutiveFailures: 2,
      });
      expect(await t.handle.db.select().from(incidents)).toHaveLength(1);
    });

    it('a tool whose failure was recorded before the column existed (version null) counts as version 1', async () => {
      await syncTools(t, 'acme-node');
      await cycle(0, failing('acme-node', 1));
      await t.handle.db
        .update(tools)
        .set({ lastFailureHarnessVersion: null })
        .where(eq(tools.slug, 'acme-node'));
      await cycle(1, failing('acme-node', 2));
      expect(await toolRow(t, 'acme-node')).toMatchObject({
        status: 'DEGRADED',
        consecutiveFailures: 1,
        lastFailureHarnessVersion: 2,
      });
      expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    });
  },
);

d('a version bump alone changes no target status', () => {
  it('HEALTHY, DEGRADED and BROKEN tools keep their status when the same results arrive under v2', async () => {
    await syncTools(t, 'a-healthy', 'b-degraded', 'c-broken');
    // the history under v1: a passes, b fails once, c fails twice
    await cycle(0, (c, time) => [
      pass(c, 'a-healthy', time),
      fail(c, 'b-degraded', DRIFT_STDERR, time),
      fail(c, 'c-broken', DRIFT_STDERR, time),
    ]);
    await cycle(1, (c, time) => [
      pass(c, 'a-healthy', time),
      fail(c, 'c-broken', DRIFT_STDERR, time),
    ]);
    const before = {
      a: await toolRow(t, 'a-healthy'),
      b: await toolRow(t, 'b-degraded'),
      c: await toolRow(t, 'c-broken'),
    };
    expect([before.a?.status, before.b?.status, before.c?.status]).toEqual([
      'HEALTHY',
      'DEGRADED',
      'BROKEN',
    ]);
    const incidentsBefore = await t.handle.db.select().from(incidents);
    expect(incidentsBefore).toHaveLength(1);

    // the first cycle under v2: the same observations as before for each tool
    const bump = await cycle(2, (c, time) => [
      pass(c, 'a-healthy', time, v(2)),
      fail(c, 'b-degraded', DRIFT_STDERR, time, v(2)),
      fail(c, 'c-broken', DRIFT_STDERR, time, v(2)),
    ]);
    expect(await toolRow(t, 'a-healthy')).toMatchObject({ status: 'HEALTHY' });
    expect(await toolRow(t, 'b-degraded')).toMatchObject({ status: 'DEGRADED' }); // NOT BROKEN: its earlier failure was version 1
    expect(await toolRow(t, 'c-broken')).toMatchObject({ status: 'BROKEN' });
    // no status changed, and no incident event was produced by the bump
    for (const entry of bump.finished.tools) expect(entry.before, entry.slug).toBe(entry.after);
    expect(bump.finished.tools.flatMap((e: { events: unknown[] }) => e.events)).toEqual([]);
    expect(await t.handle.db.select().from(incidents)).toHaveLength(1);
  });
});

d('shadow mode: the export check is recorded and never acted on', () => {
  const SHADOW_FAIL: ShadowExportCheck = {
    outcome: 'fail',
    missing: ['acme: Gone'],
    note: null,
    durationMs: 90,
  };
  const withShadow =
    (shadow: ShadowExportCheck | null) =>
    (cycleId: string, slug: string, time: string): RunResult =>
      pass(cycleId, slug, time, {
        harnessVersion: 2,
        reachedLevel: 2,
        steps: [
          step('s1', 0, 'shell'),
          step('s2', 1, 'write_file'),
          step('qsr-check-syntax', 2, 'harness_check'),
          step('qsr-check-imports', 3, 'harness_check', { shadowExportCheck: shadow }),
        ],
      });

  it('is stored on the imports-check step, as sent', async () => {
    await syncTools(t, 'acme-node');
    await cycle(0, (c, time) => [withShadow(SHADOW_FAIL)(c, 'acme-node', time)]);
    const rows = await t.handle.db.select().from(stepResults);
    const marked = rows.filter((r) => r.shadowExportCheck !== null);
    expect(marked.map((r) => r.stepId)).toEqual(['qsr-check-imports']);
    expect(marked[0]?.shadowExportCheck).toEqual(SHADOW_FAIL);
  });

  it('a PASS with a shadow FAIL leaves the run PASS and the tool HEALTHY, with no queue item and no incident', async () => {
    await syncTools(t, 'acme-node');
    const r = await cycle(0, (c, time) => [withShadow(SHADOW_FAIL)(c, 'acme-node', time)]);
    expect(r.finished.tools).toEqual([
      { slug: 'acme-node', before: 'UNKNOWN', after: 'HEALTHY', events: [] },
    ]);
    const [run] = await t.handle.db.select().from(runs).where(eq(runs.cycleId, r.cycleId));
    const mine = (await t.handle.db.select().from(runs)).filter((x) => x.outcome === 'PASS');
    expect(mine.length).toBeGreaterThan(0);
    expect(run).toBeDefined();
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    expect(
      await t.handle.db
        .select()
        .from(adminQueueItems)
        .where(eq(adminQueueItems.reason, 'unknown_failure')),
    ).toHaveLength(0);
  });

  it('the same results with and without shadow data leave identical runs, classifications, tool states, queue items and incidents', async () => {
    await syncTools(t, 'with-shadow', 'no-shadow');
    const mixed =
      (shadow: ShadowExportCheck | null) =>
      (c: string, time: string): RunResult[] => [
        withShadow(shadow)(c, 'with-shadow', time),
        withShadow(null)(c, 'no-shadow', time),
      ];
    await cycle(0, mixed(SHADOW_FAIL));
    await cycle(1, (c, time) => [
      fail(c, 'with-shadow', DRIFT_STDERR, time, v(2)),
      fail(c, 'no-shadow', DRIFT_STDERR, time, v(2)),
    ]);
    await cycle(2, (c, time) => [
      fail(c, 'with-shadow', DRIFT_STDERR, time, {
        harnessVersion: 2,
        steps: [
          step('s1', 0, 'shell'),
          step('s2', 1, 'write_file'),
          step('qsr-check-imports', 2, 'harness_check', { shadowExportCheck: SHADOW_FAIL }),
          step('s3', 3, 'run', { outcome: 'FAIL', exitCode: 1, stderrTail: DRIFT_STDERR }),
        ],
        failedStepId: 's3',
        reachedLevel: 2,
      }),
      fail(c, 'no-shadow', DRIFT_STDERR, time, {
        harnessVersion: 2,
        steps: [
          step('s1', 0, 'shell'),
          step('s2', 1, 'write_file'),
          step('qsr-check-imports', 2, 'harness_check'),
          step('s3', 3, 'run', { outcome: 'FAIL', exitCode: 1, stderrTail: DRIFT_STDERR }),
        ],
        failedStepId: 's3',
        reachedLevel: 2,
      }),
    ]);
    const a = await toolRow(t, 'with-shadow');
    const b = await toolRow(t, 'no-shadow');
    const state = (x: typeof a) => ({
      status: x?.status,
      f: x?.consecutiveFailures,
      p: x?.consecutivePasses,
      sig: x?.lastFailureSignature,
      cls: x?.lastFailureClass,
      v: x?.lastFailureHarnessVersion,
    });
    expect(state(a)).toEqual(state(b));
    const all = await t.handle.db.select().from(runs);
    const mine = (tool: typeof a) =>
      all
        .filter((r) => r.toolId === tool?.id)
        .map((r) => ({
          outcome: r.outcome,
          cls: r.failureClass,
          sig: r.failureSignature,
          rule: r.classifierRule,
          level: r.reachedLevel,
          failed: r.failedStepId,
        }));
    expect(mine(a)).toEqual(mine(b));
    const incs = await t.handle.db.select().from(incidents);
    expect(incs.filter((i) => i.toolId === a?.id)).toHaveLength(
      incs.filter((i) => i.toolId === b?.id).length,
    );
    const queue = await t.handle.db.select().from(adminQueueItems);
    expect(queue.filter((q) => q.toolId === a?.id).map((q) => q.reason)).toEqual(
      queue.filter((q) => q.toolId === b?.id).map((q) => q.reason),
    );
  });

  it('is in no public view: the shadow column does not exist there and the steps JSON has no such key', async () => {
    await syncTools(t, 'acme-node');
    await cycle(0, (c, time) => [withShadow(SHADOW_FAIL)(c, 'acme-node', time)]);
    const sql = t.handle.sql;
    const columns =
      await sql`select column_name from information_schema.columns where table_name in ('public_runs', 'public_tools', 'public_incidents', 'public_run_history')`;
    expect(
      columns.map((c) => String(c.column_name)).filter((n) => /shadow|export/i.test(n)),
    ).toEqual([]);
    const rows = await sql`select steps from public_runs where tool_slug = 'acme-node'`;
    expect(JSON.stringify(rows)).not.toMatch(/shadow|export_check/i);
    const stored = await t.handle.db
      .select()
      .from(stepResults)
      .where(and(eq(stepResults.stepId, 'qsr-check-imports')));
    expect(stored.some((s) => s.shadowExportCheck !== null)).toBe(true); // it is stored, just never read back into a verdict
  });
});
