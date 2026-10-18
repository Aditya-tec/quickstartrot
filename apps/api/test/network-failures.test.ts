import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { adminQueueItems, incidents, probeCycles, runs } from '@qsr/db';
import type { RunResult } from '@qsr/core';
import { resetDb, startTestApp, type TestApp } from './helpers.js';
import { DRIFT_STDERR, runResult } from './fixtures.js';
import {
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

// P9d follow-up: a failure of the RUNNER'S NETWORK (DNS, a registry timeout, an image that cannot be pulled) is never a vendor failure.
//   * seen by one tool in a valid cycle: it is NETWORK_TRANSIENT, it never touches the vendor failure memory (so it cannot be the
//     second of two consecutive vendor failures), and it opens nothing until four in a row (the spec's transient rule, review-gated);
//   * seen by the whole runner: the canaries misbehave, the cycle is INVALID, and nothing at all is applied;
//   * an image that cannot be pulled is a HARNESS_ERROR (ours), which goes to the admin queue and never becomes an incident.
// These run raw runner output through the real classifier and the real status engine in the API.

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

const DNS_NPM =
  'npm error code ENOTFOUND\nnpm error syscall getaddrinfo\nnpm error errno ENOTFOUND\nnpm error network request to https://registry.npmjs.org/acme-sdk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n';
const TIMEOUT_NPM =
  'npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/acme-sdk failed\n';
const DNS_PIP =
  "WARNING: Retrying (Retry(total=4)) after connection broken by 'NewConnectionError(Failed to establish a new connection: [Errno -3] Temporary failure in name resolution)': /simple/acme-sdk/\nERROR: Could not find a version that satisfies the requirement acme-sdk\n";

/** A run that never started: the sandbox image could not be pulled (ours, not the vendor's). */
const pullFailure = (cycleId: string, slug: string, time: string): RunResult =>
  stamp(
    runResult({
      cycleId,
      toolSlug: slug,
      outcome: 'HARNESS_ERROR',
      reachedLevel: 0,
      failedStepId: null,
      steps: [],
    }),
    time,
  );

async function cycle(day: number, results: (cycleId: string, time: string) => RunResult[]) {
  const cycleId = await newCycle(t, day);
  const time = at(day, 1);
  await postRuns(t, results(cycleId, time));
  t.clock.now = new Date(Date.parse(time) + 60_000);
  const res = await finishCycle(t, cycleId);
  expect(res.statusCode, res.body).toBe(200);
  const [row] = (await t.handle.db.select().from(probeCycles)).filter((c) => c.id === cycleId);
  return { cycleId, res, valid: row?.valid };
}

/** Healthy canaries plus these results: a valid cycle. */
const valid =
  (...results: ((cycleId: string, time: string) => RunResult)[]) =>
  (cycleId: string, time: string): RunResult[] => [
    ...canaryResults(cycleId, time),
    ...results.map((r) => r(cycleId, time)),
  ];

d('a failure of the runner network is never a vendor failure', () => {
  it.each([
    ['npm DNS failure (ENOTFOUND)', DNS_NPM],
    ['npm registry timeout (ETIMEDOUT)', TIMEOUT_NPM],
    ['pip name resolution failure', DNS_PIP],
  ])('%s is classified NETWORK_TRANSIENT from the raw output', async (_name, stderr) => {
    await syncTools(t, 'acme-node');
    await cycle(
      0,
      valid((c, time) => pass(c, 'acme-node', time)),
    );
    await cycle(
      1,
      valid((c, time) => fail(c, 'acme-node', stderr, time)),
    );
    const all = await t.handle.db.select().from(runs);
    const failed = all.filter((r) => r.outcome === 'FAIL' && r.failureClass !== null);
    const mine = failed.find((r) => r.failureClass === 'NETWORK_TRANSIENT');
    expect(mine, `no NETWORK_TRANSIENT run for: ${stderr.slice(0, 60)}`).toBeDefined();
  });

  it('one tool seeing DNS failures twice in valid cycles is DEGRADED with no vendor failure memory, no incident, and the next vendor failure is a FIRST failure', async () => {
    await syncTools(t, 'acme-node');
    await cycle(
      0,
      valid((c, time) => pass(c, 'acme-node', time)),
    );
    for (const day of [1, 2]) {
      const r = await cycle(
        day,
        valid((c, time) => fail(c, 'acme-node', DNS_NPM, time)),
      );
      expect(r.valid).toBe(true);
      expect(
        r.res.json().tools.find((x: { slug: string }) => x.slug === 'acme-node'),
      ).toMatchObject({ after: 'DEGRADED' });
    }
    expect(await toolRow(t, 'acme-node')).toMatchObject({
      status: 'DEGRADED',
      consecutiveFailures: 0,
      lastFailureSignature: null,
      transientStreak: 2,
    });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);

    // the first real vendor failure after them counts as ONE, not as the second of anything
    await cycle(
      3,
      valid((c, time) => fail(c, 'acme-node', DRIFT_STDERR, time)),
    );
    expect(await toolRow(t, 'acme-node')).toMatchObject({
      status: 'DEGRADED',
      consecutiveFailures: 1,
      transientStreak: 0,
    });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
  });

  it('a registry outage that reaches the canaries makes the cycle INVALID: no tool changes, nothing is counted, no incident, however many cycles it lasts', async () => {
    await syncTools(t, 'acme-node', 'beta-node');
    await cycle(
      0,
      valid(
        (c, time) => pass(c, 'acme-node', time),
        (c, time) => pass(c, 'beta-node', time),
      ),
    );
    const before = [await toolRow(t, 'acme-node'), await toolRow(t, 'beta-node')];
    for (const day of [1, 2, 3, 4, 5]) {
      const r = await cycle(day, (c, time) => [
        // every sandbox install fails on DNS, canaries included: the pass canaries FAIL and the dep canary gets the wrong class
        fail(c, 'canary-pass-node', DNS_NPM, time),
        fail(c, 'canary-pass-python', DNS_PIP, time),
        fail(c, 'canary-fail-drift', DNS_NPM, time),
        fail(c, 'canary-fail-dep', DNS_NPM, time),
        fail(c, 'acme-node', DNS_NPM, time),
        fail(c, 'beta-node', TIMEOUT_NPM, time),
      ]);
      expect(r.valid, `day ${day}`).toBe(false);
    }
    for (const prior of before) {
      const now = await toolRow(t, prior?.slug as string);
      expect(now).toMatchObject({
        status: 'HEALTHY',
        consecutiveFailures: 0,
        transientStreak: 0,
        lastFailureSignature: null,
      });
    }
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
  });

  it('an image that cannot be pulled (HARNESS_ERROR on every run of the shard, canaries included) makes the cycle INVALID and applies nothing', async () => {
    await syncTools(t, 'acme-node');
    await cycle(
      0,
      valid((c, time) => pass(c, 'acme-node', time)),
    );
    for (const day of [1, 2, 3]) {
      const r = await cycle(day, (c, time) => [
        pullFailure(c, 'canary-pass-node', time),
        pullFailure(c, 'canary-pass-python', time),
        pullFailure(c, 'canary-fail-drift', time),
        pullFailure(c, 'canary-fail-dep', time),
        pullFailure(c, 'acme-node', time),
      ]);
      expect(r.valid, `day ${day}`).toBe(false);
    }
    expect(await toolRow(t, 'acme-node')).toMatchObject({
      status: 'HEALTHY',
      consecutiveFailures: 0,
      transientStreak: 0,
    });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
  });

  it('a pull failure for one tool in a valid cycle is ours: an admin queue item, never an incident, never a streak', async () => {
    await syncTools(t, 'acme-node');
    await cycle(
      0,
      valid((c, time) => pass(c, 'acme-node', time)),
    );
    for (const day of [1, 2, 3, 4, 5]) {
      const r = await cycle(
        day,
        valid((c, time) => pullFailure(c, 'acme-node', time)),
      );
      expect(r.valid).toBe(true);
    }
    expect(await toolRow(t, 'acme-node')).toMatchObject({
      status: 'HEALTHY',
      consecutiveFailures: 0,
      transientStreak: 0,
      lastFailureSignature: null,
    });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    expect((await t.handle.db.select().from(adminQueueItems)).length).toBeGreaterThan(0);
  });
});
