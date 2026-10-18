import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { ShadowReportResponse, type RunResult, type ShadowExportCheck } from '@qsr/core';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import { step } from './fixtures.js';
import { CANARY_SLUGS } from '@qsr/core';
import {
  at,
  canaryResults,
  finishCycle,
  newCycle,
  pass,
  postRuns,
  syncTools,
} from './cycle-helpers.js';

// GET /admin/shadow?days=N (P9d): per target, how many cycles ran, how the shadow export check came out, the names it reported
// missing, and the list of false-positive CANDIDATES. It reads recorded shadow results and nothing else.

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

const PASS: ShadowExportCheck = { outcome: 'pass', missing: [], note: null, durationMs: 40 };
const FAIL = (...missing: string[]): ShadowExportCheck => ({
  outcome: 'fail',
  missing,
  note: null,
  durationMs: 60,
});
const SKIPPED = (note: string): ShadowExportCheck => ({
  outcome: 'skipped',
  missing: [],
  note,
  durationMs: 0,
});

/** A passing run at L2 whose imports-check step carries `shadow` (null: the plan has no L2 checks, nothing was shadowed). */
const run = (
  cycleId: string,
  slug: string,
  time: string,
  shadow: ShadowExportCheck | null,
  version = 2,
): RunResult =>
  pass(cycleId, slug, time, {
    harnessVersion: version,
    reachedLevel: 2,
    steps: [
      step('s1', 0, 'shell'),
      step('s2', 1, 'write_file'),
      step('qsr-check-syntax', 2, 'harness_check'),
      step('qsr-check-imports', 3, 'harness_check', { shadowExportCheck: shadow }),
    ],
  });

async function cycle(day: number, results: (cycleId: string, time: string) => RunResult[]) {
  const cycleId = await newCycle(t, day);
  const time = at(day, 1);
  await postRuns(t, [...canaryResults(cycleId, time), ...results(cycleId, time)]);
  t.clock.now = new Date(Date.parse(time) + 60_000);
  expect((await finishCycle(t, cycleId)).statusCode).toBe(200);
}
const report = async (query = '?days=7') => {
  const res = await t.admin('GET', `/admin/shadow${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return ShadowReportResponse.parse(res.json());
};

d('GET /admin/shadow', () => {
  it('requires the admin token and a sane days', async () => {
    expect(
      (await t.admin('GET', '/admin/shadow', undefined, 'wrong-token-wrong-token-wrong'))
        .statusCode,
    ).toBe(401);
    for (const bad of ['?days=0', '?days=91', '?days=x'])
      expect((await t.admin('GET', `/admin/shadow${bad}`)).statusCode, bad).toBe(400);
    expect((await t.admin('GET', '/admin/shadow')).statusCode).toBe(200);
  });

  it('counts cycles and results per tool, collects the missing names with how many cycles named each, and lists every failing tool as a candidate', async () => {
    await syncTools(
      t,
      'steady-node',
      'flaky-node',
      'stable-fail-node',
      'quiet-node',
      'optout-node',
    );
    // 4 cycles one day apart; clock for "now" is the day of the last one
    await cycle(0, (c, time) => [
      run(c, 'steady-node', time, PASS),
      run(c, 'flaky-node', time, FAIL('acme: A')),
      run(c, 'stable-fail-node', time, FAIL('acme: B', 'acme.sub')),
      run(c, 'quiet-node', time, null),
      run(c, 'optout-node', time, SKIPPED('skipExportCheck: the snippet is TypeScript')),
    ]);
    await cycle(1, (c, time) => [
      run(c, 'steady-node', time, PASS),
      run(c, 'flaky-node', time, PASS),
      run(c, 'stable-fail-node', time, FAIL('acme: B', 'acme.sub')),
      run(c, 'quiet-node', time, null),
      run(c, 'optout-node', time, SKIPPED('skipExportCheck: the snippet is TypeScript')),
    ]);
    await cycle(2, (c, time) => [
      run(c, 'steady-node', time, {
        ...PASS,
        note: 'qsr-check-exports: not checked, the package could not be loaded here: netty (blocked)',
      }),
      run(c, 'flaky-node', time, FAIL('acme: A')),
      run(c, 'stable-fail-node', time, FAIL('acme: B', 'acme.sub')),
      run(c, 'quiet-node', time, null),
      run(c, 'optout-node', time, SKIPPED('skipExportCheck: the snippet is TypeScript')),
    ]);
    t.clock.now = new Date(at(3));
    const r = await report('?days=7');
    const row = (slug: string) => r.tools.find((x) => x.slug === slug);

    expect(r.days).toBe(7);
    expect(row('steady-node')).toMatchObject({
      cycles: 3,
      withShadow: 3,
      pass: 3,
      fail: 0,
      skipped: 0,
      missing: [],
    });
    expect(row('steady-node')?.notes.join(' ')).toMatch(/not checked/);
    expect(row('flaky-node')).toMatchObject({
      cycles: 3,
      withShadow: 3,
      pass: 1,
      fail: 2,
      missing: [{ name: 'acme: A', cycles: 2 }],
    });
    expect(row('stable-fail-node')).toMatchObject({
      fail: 3,
      missing: [
        { name: 'acme.sub', cycles: 3 },
        { name: 'acme: B', cycles: 3 },
      ],
    });
    expect(row('quiet-node')).toMatchObject({
      cycles: 3,
      withShadow: 0,
      pass: 0,
      fail: 0,
      skipped: 0,
    });
    expect(row('optout-node')).toMatchObject({ skipped: 3, optOut: null }); // the reason comes from the stored target
    expect(r.totals).toMatchObject({ cycles: 3, withShadow: 12, pass: 4, fail: 5, skipped: 3 });
    expect(r.tools.map((x) => x.slug)).toEqual([...r.tools.map((x) => x.slug)].sort());

    // false-positive candidates: every tool that failed, stable ones flagged as such
    expect(r.falsePositiveCandidates.map((c) => c.slug).sort()).toEqual([
      'flaky-node',
      'stable-fail-node',
    ]);
    const stable = r.falsePositiveCandidates.find((c) => c.slug === 'stable-fail-node');
    expect(stable).toMatchObject({ failCycles: 3, checkedCycles: 3, stable: true });
    expect(stable?.missing).toEqual(['acme.sub', 'acme: B']);
    const flaky = r.falsePositiveCandidates.find((c) => c.slug === 'flaky-node');
    expect(flaky).toMatchObject({ failCycles: 2, checkedCycles: 3, stable: false });
    expect(flaky?.reason).toMatch(/intermittent/i);
    expect(stable?.reason).toMatch(/every cycle/i);
  });

  it('counts only harness v2 runs and only the window asked for; v1 runs and old cycles are left out', async () => {
    await syncTools(t, 'acme-node');
    await cycle(0, (c, time) => [run(c, 'acme-node', time, FAIL('acme: Old'), 1)]); // a v1 run cannot carry shadow data, and is not counted
    await cycle(5, (c, time) => [run(c, 'acme-node', time, FAIL('acme: New'))]);
    t.clock.now = new Date(at(6));
    const week = await report('?days=7');
    expect(week.tools.find((x) => x.slug === 'acme-node')).toMatchObject({
      cycles: 1,
      fail: 1,
      missing: [{ name: 'acme: New', cycles: 1 }],
    });
    t.clock.now = new Date(at(9));
    const two = await report('?days=2');
    expect(two.tools.find((x) => x.slug === 'acme-node')).toBeUndefined();
    expect(two.totals).toMatchObject({ cycles: 0, withShadow: 0 });
  });

  it('shows the reason a target opted out, from the stored target file', async () => {
    const reason = 'the docs snippet is TypeScript and its types have no run-time export';
    await t.signed('/internal/targets/sync', {
      targets: [...CANARY_SLUGS, 'optout-node'].map((s) =>
        targetInput(s, {
          level: 3,
          ...(s === 'optout-node' ? { harness: { skipExportCheck: true, reason } } : {}),
        }),
      ),
    });
    await cycle(0, (c, time) => [
      run(c, 'optout-node', time, SKIPPED(`skipExportCheck: ${reason}`)),
    ]);
    t.clock.now = new Date(at(1));
    expect((await report()).tools.find((x) => x.slug === 'optout-node')).toMatchObject({
      optOut: reason,
      skipped: 1,
    });
  });

  it('an empty database gives a valid, empty answer', async () => {
    const r = await report();
    expect(r.tools).toEqual([]);
    expect(r.falsePositiveCandidates).toEqual([]);
    expect(r.totals).toEqual({ cycles: 0, runs: 0, withShadow: 0, pass: 0, fail: 0, skipped: 0 });
  });
});
