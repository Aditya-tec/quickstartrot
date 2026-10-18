import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { adminQueueItems, incidents, runs } from '@qsr/db';
import type { RunResult } from '@qsr/core';
import { resetDb, startTestApp, type TestApp } from './helpers.js';
import { step } from './fixtures.js';
import {
  at,
  canaryResults,
  finishCycle,
  newCycle,
  pass,
  postRuns,
  syncTools,
  toolRow,
} from './cycle-helpers.js';

// Harness v3: an L3 claim needs evidence that a vendor was reached. A target that used to reach L3 on the strength of an exit code
// now reaches L2. That is a change of what we claim, not a failure of the quickstart: the run still PASSES, so it must change no
// status, open no incident and queue nothing, through the real ingest and finish flow.

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

/** A PASSING run that reached `level`, with the steps of a plan that has a run step (the last one may or may not count as L3). */
const passedAt =
  (slug: string, level: 2 | 3, harnessVersion: number, l3Note?: string) =>
  (cycleId: string, time: string): RunResult =>
    pass(cycleId, slug, time, {
      harnessVersion,
      reachedLevel: level,
      steps: [
        step('s1', 0, 'shell'),
        step('s2', 1, 'write_file'),
        step('qsr-check-syntax', 2, 'harness_check'),
        step('qsr-check-imports', 3, 'harness_check'),
        step('s3', 4, 'run', { matchedAuthPattern: level === 3 ? 'http_401_403' : null }),
      ],
      runnerEnv: {
        hostPlatform: 'test',
        resolved: '{}',
        ...(l3Note === undefined ? {} : { l3: l3Note }),
      },
    });

async function cycle(day: number, result: (cycleId: string, time: string) => RunResult) {
  const cycleId = await newCycle(t, day);
  const time = at(day, 1);
  await postRuns(t, [...canaryResults(cycleId, time), result(cycleId, time)]);
  t.clock.now = new Date(Date.parse(time) + 60_000);
  expect((await finishCycle(t, cycleId)).statusCode).toBe(200);
  return cycleId;
}

d('a drop in the level we claim is not a failure', () => {
  it('a HEALTHY tool that reached L3 and now reaches L2 stays HEALTHY, with no incident and no queue item', async () => {
    await syncTools(t, 'acme-node');
    await cycle(0, passedAt('acme-node', 3, 2));
    await cycle(1, passedAt('acme-node', 3, 2));
    expect(await toolRow(t, 'acme-node')).toMatchObject({ status: 'HEALTHY' });

    await cycle(2, passedAt('acme-node', 2, 3, 'no_evidence'));
    await cycle(3, passedAt('acme-node', 2, 3, 'no_evidence'));

    expect(await toolRow(t, 'acme-node')).toMatchObject({
      status: 'HEALTHY',
      consecutiveFailures: 0,
      transientStreak: 0,
      lastFailureSignature: null,
    });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    expect(await t.handle.db.select().from(adminQueueItems)).toHaveLength(0);
  });

  it('the reason is stored with the run (runner_env.l3) and the level is the lower one', async () => {
    await syncTools(t, 'acme-node', 'local-node');
    const first = await newCycle(t, 0);
    const time = at(0, 1);
    await postRuns(t, [
      ...canaryResults(first, time),
      passedAt('acme-node', 2, 3, 'no_evidence')(first, time),
      passedAt('local-node', 2, 3, 'local')(first, time),
    ]);
    t.clock.now = new Date(Date.parse(time) + 60_000);
    expect((await finishCycle(t, first)).statusCode).toBe(200);

    const stored = await t.handle.db.select().from(runs);
    const notes = stored
      .filter((r) => r.runnerEnv['l3'] !== undefined)
      .map((r) => ({ l3: r.runnerEnv['l3'], level: r.reachedLevel }))
      .sort((a, b) => String(a.l3).localeCompare(String(b.l3)));
    expect(notes).toEqual([
      { l3: 'local', level: 2 },
      { l3: 'no_evidence', level: 2 },
    ]);
  });
});
