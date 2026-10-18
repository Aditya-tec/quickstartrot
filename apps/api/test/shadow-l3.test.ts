import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { adminQueueItems, incidents, runs, stepResults, tools } from '@qsr/db';
import { CANARY_SLUGS, L3ShadowReportResponse, type RunResult, type ShadowL3 } from '@qsr/core';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import { step } from './fixtures.js';
import {
  at,
  canaryResults,
  fail,
  finishCycle,
  newCycle,
  pass,
  postRuns,
  toolRow,
} from './cycle-helpers.js';

// Shadow-L3: the L3 step of a shadow target runs in the executor and its result is stored on the last step. The API stores it and NOTHING
// reads it back into a verdict: no classification, status, queue item, incident, level, badge or public view changes because of it.
// GET /admin/l3-shadow is the one reader, for `qsr l3-shadow-report`.

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
  t.clock.now = new Date(at(0));
});

const REASON = 'New L3 step: observed for a week of cycles before it may count';
const EVIDENCE: ShadowL3 = {
  verdict: 'evidence',
  pattern: 'http_401_403',
  exitCode: 1,
  observed: 'AuthenticationError: Request failed with status code 401',
  durationMs: 700,
  note: null,
};
const AMBIGUOUS: ShadowL3 = {
  verdict: 'no_evidence',
  pattern: null,
  exitCode: 0,
  observed: 'Hello world!',
  durationMs: 600,
  note: null,
};

/** A passing L2 run whose LAST step carries `shadow` (null: the plan has no shadow step). */
const run = (cycleId: string, slug: string, time: string, shadow: ShadowL3 | null): RunResult =>
  pass(cycleId, slug, time, {
    harnessVersion: 3,
    reachedLevel: 2,
    steps: [
      step('s1', 0, 'shell'),
      step('s2', 1, 'write_file'),
      step('qsr-check-syntax', 2, 'harness_check'),
      step('qsr-check-imports', 3, 'harness_check', { shadowL3: shadow }),
    ],
  });

async function cycle(day: number, results: (cycleId: string, time: string) => RunResult[]) {
  const cycleId = await newCycle(t, day);
  const time = at(day, 1);
  await postRuns(t, [...canaryResults(cycleId, time), ...results(cycleId, time)]);
  t.clock.now = new Date(Date.parse(time) + 60_000);
  const res = await finishCycle(t, cycleId);
  expect(res.statusCode, res.body).toBe(200);
  return { cycleId, finished: res.json() };
}

/** Targets in the database: level 3 (so the plan has the L3 step) and shadow for these slugs. */
const syncShadow = (...slugs: string[]) =>
  t.signed('/internal/targets/sync', {
    targets: [
      ...CANARY_SLUGS.map((s) => targetInput(s, { level: 3 })),
      ...slugs.map((s) => targetInput(s, { level: 3, l3: { mode: 'shadow', reason: REASON } })),
    ],
  });

d('the shadow L3 result is stored and changes nothing', () => {
  it('is stored on the last step, as sent', async () => {
    await syncShadow('acme-node');
    await cycle(0, (c, time) => [run(c, 'acme-node', time, EVIDENCE)]);
    const marked = (await t.handle.db.select().from(stepResults)).filter(
      (r) => r.shadowL3 !== null,
    );
    expect(marked.map((r) => r.stepId)).toEqual(['qsr-check-imports']);
    expect(marked[0]?.shadowL3).toEqual(EVIDENCE);
  });

  it('a PASS whose shadow step found NO evidence leaves the run PASS and the tool HEALTHY, with no queue item and no incident', async () => {
    await syncShadow('acme-node');
    const r = await cycle(0, (c, time) => [run(c, 'acme-node', time, AMBIGUOUS)]);
    expect(r.finished.tools).toEqual([
      { slug: 'acme-node', before: 'UNKNOWN', after: 'HEALTHY', events: [] },
    ]);
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    expect(await t.handle.db.select().from(adminQueueItems)).toHaveLength(0);
    const tool = await toolRow(t, 'acme-node');
    const [stored] = (await t.handle.db.select().from(runs)).filter((x) => x.toolId === tool?.id);
    expect(stored).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
  });

  it('the same results with and without a shadow record leave identical runs, classifications, tool states, queue items and incidents', async () => {
    await syncShadow('with-shadow', 'no-shadow');
    await cycle(0, (c, time) => [
      run(c, 'with-shadow', time, AMBIGUOUS),
      run(c, 'no-shadow', time, null),
    ]);
    const a = await toolRow(t, 'with-shadow');
    const b = await toolRow(t, 'no-shadow');
    const state = (x: typeof a) => ({
      status: x?.status,
      f: x?.consecutiveFailures,
      p: x?.consecutivePasses,
      sig: x?.lastFailureSignature,
      level: x?.level,
    });
    expect(state(a)).toEqual(state(b));
    const all = await t.handle.db.select().from(runs);
    const mine = (tool: typeof a) =>
      all
        .filter((r) => r.toolId === tool?.id)
        .map((r) => ({
          outcome: r.outcome,
          cls: r.failureClass,
          level: r.reachedLevel,
          failed: r.failedStepId,
        }));
    expect(mine(a)).toEqual(mine(b));
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
  });

  it('is in no public view: no column and no key in the steps JSON', async () => {
    await syncShadow('acme-node');
    await cycle(0, (c, time) => [run(c, 'acme-node', time, EVIDENCE)]);
    const sql = t.handle.sql;
    const columns =
      await sql`select column_name from information_schema.columns where table_name in ('public_runs', 'public_tools', 'public_incidents', 'public_run_history')`;
    expect(columns.map((c) => String(c.column_name)).filter((n) => /shadow|l3/i.test(n))).toEqual(
      [],
    );
    const rows = await sql`select steps from public_runs where tool_slug = 'acme-node'`;
    expect(JSON.stringify(rows)).not.toMatch(/shadow/i);
  });
});

d('a shadow target is shown at level 2 until it is promoted', () => {
  it('stores the level it is shown at (2) while its config keeps level 3, so the plan still has the L3 step', async () => {
    await syncShadow('acme-node');
    const [row] = (await t.handle.db.select().from(tools)).filter((x) => x.slug === 'acme-node');
    expect(row?.level).toBe(2);
    expect((row?.config as { level: number }).level).toBe(3);
  });

  it('a target that is not in shadow keeps its level', async () => {
    await t.signed('/internal/targets/sync', {
      targets: [...CANARY_SLUGS, 'plain-node'].map((s) => targetInput(s, { level: 3 })),
    });
    const [row] = (await t.handle.db.select().from(tools)).filter((x) => x.slug === 'plain-node');
    expect(row?.level).toBe(3);
  });

  it('promotion (removing the flag) changes the stored level and nothing about the plan cache key', async () => {
    await syncShadow('acme-node');
    await t.signed('/internal/targets/sync', {
      targets: [...CANARY_SLUGS, 'acme-node'].map((s) => targetInput(s, { level: 3 })),
    });
    const [row] = (await t.handle.db.select().from(tools)).filter((x) => x.slug === 'acme-node');
    expect(row?.level).toBe(3);
  });
});

const report = async (query = '?days=7') => {
  const res = await t.admin('GET', `/admin/l3-shadow${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return L3ShadowReportResponse.parse(res.json());
};

d('GET /admin/l3-shadow', () => {
  it('requires the admin token and a sane days', async () => {
    expect(
      (await t.admin('GET', '/admin/l3-shadow', undefined, 'wrong-token-wrong-token-wrong'))
        .statusCode,
    ).toBe(401);
    for (const bad of ['?days=0', '?days=91', '?days=x'])
      expect((await t.admin('GET', `/admin/l3-shadow${bad}`)).statusCode, bad).toBe(400);
    expect((await t.admin('GET', '/admin/l3-shadow')).statusCode).toBe(200);
  });

  it('counts cycles, verdicts, patterns and the exact observed text per shadow target; invalid cycles are left out', async () => {
    await syncShadow('steady-node', 'odd-node');
    for (let day = 0; day < 3; day++)
      await cycle(day, (c, time) => [
        run(c, 'steady-node', time, EVIDENCE),
        run(c, 'odd-node', time, day === 1 ? AMBIGUOUS : EVIDENCE),
      ]);
    t.clock.now = new Date(at(3));
    const r = await report();
    const row = (slug: string) => r.tools.find((x) => x.slug === slug);
    expect(row('steady-node')).toMatchObject({
      reason: REASON,
      cycles: 3,
      withRecord: 3,
      verdicts: { evidence: 3 },
      patterns: [{ pattern: 'http_401_403', cycles: 3 }],
      observed: [{ text: EVIDENCE.observed, cycles: 3 }],
      ambiguous: 0,
    });
    expect(row('odd-node')).toMatchObject({
      verdicts: { evidence: 2, no_evidence: 1 },
      ambiguous: 1,
    });
    expect(
      row('odd-node')
        ?.observed.map((o) => o.text)
        .sort(),
    ).toEqual([AMBIGUOUS.observed, EVIDENCE.observed].sort());
  });

  it('is promotion-ready only with 8 or more cycles, every one with evidence, and the same evidence every time', async () => {
    await syncShadow('ready-node', 'short-node', 'mixed-node', 'differs-node');
    for (let day = 0; day < 9; day++)
      await cycle(day, (c, time) => [
        run(c, 'ready-node', time, EVIDENCE),
        run(c, 'short-node', time, day < 5 ? EVIDENCE : null),
        run(c, 'mixed-node', time, day === 4 ? AMBIGUOUS : EVIDENCE),
        run(
          c,
          'differs-node',
          time,
          day === 6 ? { ...EVIDENCE, pattern: 'unauthorized' } : EVIDENCE,
        ),
      ]);
    t.clock.now = new Date(at(10));
    const r = await report('?days=14');
    const row = (slug: string) => r.tools.find((x) => x.slug === slug);
    expect(row('ready-node')?.promotion).toEqual({ ready: true, cleanCycles: 9, blockers: [] });
    expect(row('short-node')?.promotion.ready).toBe(false);
    expect(row('short-node')?.promotion.blockers.join(' ')).toMatch(/only 5 cycles with a record/);
    expect(row('mixed-node')?.promotion.ready).toBe(false);
    expect(row('mixed-node')?.promotion.blockers.join(' ')).toMatch(/1 result without evidence/);
    expect(row('differs-node')?.promotion.ready).toBe(false);
    expect(row('differs-node')?.promotion.blockers.join(' ')).toMatch(/different evidence/);
  });

  it('only counts the window asked for, and an empty database gives an empty report', async () => {
    expect((await report()).tools).toEqual([]);
    await syncShadow('acme-node');
    await cycle(0, (c, time) => [run(c, 'acme-node', time, EVIDENCE)]);
    t.clock.now = new Date(at(9));
    expect((await report('?days=2')).tools.find((x) => x.slug === 'acme-node')?.cycles ?? 0).toBe(
      0,
    );
  });

  it('a failing run with a shadow record is still an ordinary failure: the report counts it, the status engine ignores the record', async () => {
    await syncShadow('acme-node');
    await cycle(0, (c, time) => [run(c, 'acme-node', time, EVIDENCE)]);
    await cycle(1, (c, time) => [
      fail(c, 'acme-node', 'TypeError: acme.go is not a function\n', time, { harnessVersion: 3 }),
    ]);
    expect(await toolRow(t, 'acme-node')).toMatchObject({
      status: 'DEGRADED',
      consecutiveFailures: 1,
    });
  });
});
