import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  adminQueueItems,
  docSnapshots,
  incidentEvents,
  incidents,
  llmCalls,
  probeCycles,
  runs,
  tools,
} from '@qsr/db';
import { CANARY_SLUGS, type RunResult } from '@qsr/core';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import { DRIFT_STDERR, E404_STDERR, failedRun, runResult, step } from './fixtures.js';

// POST /internal/cycles/:id/finish (spec section 11, "Cycle finish transaction"), against a real Postgres.
// Status is applied here and only here, and only when the cycle is valid: a harness bug can never push a
// vendor into DEGRADED or open an incident.

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp(dbUrl as string);
});
afterAll(async () => {
  await t?.close();
});

const DAY = 24 * 3600 * 1000;
const BASE = Date.parse('2026-10-16T12:00:00.000Z');
const at = (day: number, minute = 0): string =>
  new Date(BASE + day * DAY + minute * 60_000).toISOString();

const TIMEOUT_STDERR =
  'npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/acme-sdk failed\n';
const UNKNOWN_STDERR = 'widget refused: protocol v2 required\n';

beforeEach(async () => {
  await resetDb(t.handle);
  t.llm.reset();
  t.fetchCalls.length = 0;
  t.fetchReplies.length = 0;
  t.storage.puts.length = 0;
  t.logs.length = 0;
  t.clock.now = new Date(BASE);
});

const sync = (...slugs: string[]) =>
  t.signed('/internal/targets/sync', {
    targets: [...CANARY_SLUGS, ...slugs].map((s) => targetInput(s, { level: 3 })),
  });

async function newCycle(day: number): Promise<string> {
  t.clock.now = new Date(BASE + day * DAY);
  const res = await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' });
  return res.json().cycleId as string;
}

/** A run that finished at `time`. */
function stamp(result: RunResult, time: string): RunResult {
  return {
    ...result,
    startedAt: new Date(Date.parse(time) - 5000).toISOString(),
    finishedAt: time,
  };
}
const pass = (cycleId: string, slug: string, time: string, extra: Partial<RunResult> = {}) =>
  stamp(runResult({ cycleId, toolSlug: slug, ...extra }), time);
const fail = (
  cycleId: string,
  slug: string,
  stderr: string,
  time: string,
  extra: Partial<RunResult> = {},
) => stamp(failedRun(cycleId, stderr, extra, slug), time);

function canaryResults(
  cycleId: string,
  time: string,
  wrong: Record<string, RunResult | null> = {},
): RunResult[] {
  const make: Record<string, RunResult> = {
    'canary-pass-node': pass(cycleId, 'canary-pass-node', time),
    'canary-pass-python': pass(cycleId, 'canary-pass-python', time),
    'canary-fail-drift': fail(cycleId, 'canary-fail-drift', DRIFT_STDERR, time),
    'canary-fail-dep': stamp(
      runResult({
        cycleId,
        toolSlug: 'canary-fail-dep',
        outcome: 'FAIL',
        reachedLevel: 0,
        failedStepId: 's1',
        steps: [step('s1', 0, 'shell', { outcome: 'FAIL', exitCode: 1, stderrTail: E404_STDERR })],
      }),
      time,
    ),
  };
  return CANARY_SLUGS.flatMap((slug) => {
    const override = wrong[slug];
    return override === null ? [] : [override ?? (make[slug] as RunResult)];
  });
}

async function report(results: RunResult[]) {
  for (const r of results) {
    const res = await t.signed('/internal/runs', { runResult: r, logPaths: {} });
    expect(res.statusCode, `${r.toolSlug}: ${res.body}`).toBe(200);
  }
}
const finish = (cycleId: string) => t.signed(`/internal/cycles/${cycleId}/finish`);
const tool = async (slug: string) =>
  (await t.handle.db.select().from(tools).where(eq(tools.slug, slug)))[0];

/** One cycle on `day` where the canaries behave and these tool results are reported. */
async function cycle(day: number, results: (cycleId: string, time: string) => RunResult[]) {
  const cycleId = await newCycle(day);
  const time = at(day, 1);
  await report([...canaryResults(cycleId, time), ...results(cycleId, time)]);
  t.clock.now = new Date(Date.parse(time) + 60_000);
  return { cycleId, res: await finish(cycleId) };
}
const failing = (slug: string, stderr: string) => (c: string, time: string) => [
  fail(c, slug, stderr, time),
];
const passing = (slug: string) => (c: string, time: string) => [pass(c, slug, time)];

d('a valid cycle', () => {
  it('moves a tool from UNKNOWN to HEALTHY on its first PASS and records the cycle', async () => {
    await sync('acme-node');
    const { cycleId, res } = await cycle(0, passing('acme-node'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      cycleId,
      valid: true,
      canaryOk: true,
      canaryProblems: [],
      ignored: null,
    });
    expect(body.tools).toEqual([
      { slug: 'acme-node', before: 'UNKNOWN', after: 'HEALTHY', events: [] },
    ]);
    expect(await tool('acme-node')).toMatchObject({
      status: 'HEALTHY',
      consecutivePasses: 1,
      consecutiveFailures: 0,
      transientStreak: 0,
      lastFailureSignature: null,
    });
    expect((await tool('acme-node'))?.statusSince?.toISOString()).toBe(at(0, 1));
    expect((await tool('acme-node'))?.lastRunAt?.toISOString()).toBe(at(0, 1));
    const [row] = await t.handle.db.select().from(probeCycles).where(eq(probeCycles.id, cycleId));
    expect(row).toMatchObject({ valid: true, canaryOk: true });
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.finishResult).toMatchObject({ cycleId, valid: true });
  });

  it('canaries never enter the status engine: they stay UNKNOWN and never open an incident, though two of them FAIL', async () => {
    await sync('acme-node');
    await cycle(0, passing('acme-node'));
    await cycle(1, passing('acme-node'));
    for (const slug of CANARY_SLUGS)
      expect(await tool(slug), slug).toMatchObject({
        status: 'UNKNOWN',
        consecutiveFailures: 0,
        consecutivePasses: 0,
      });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
  });

  it('a tool with NO run in the cycle is left exactly as it was', async () => {
    await sync('acme-node', 'silent-node');
    await cycle(0, (c, time) => [pass(c, 'acme-node', time), pass(c, 'silent-node', time)]);
    const before = await tool('silent-node');
    const { res } = await cycle(1, passing('acme-node'));
    expect(res.json().tools.map((x: { slug: string }) => x.slug)).toEqual(['acme-node']);
    expect(await tool('silent-node')).toEqual(before);
  });

  it('the FINAL attempt of a tool is the one that counts (a transient retry that passed)', async () => {
    await sync('acme-node');
    const { res } = await cycle(0, (c, time) => [
      fail(c, 'acme-node', TIMEOUT_STDERR, time, { attempt: 1 }),
      pass(c, 'acme-node', time, { attempt: 2 }),
    ]);
    expect(res.json().tools).toEqual([
      { slug: 'acme-node', before: 'UNKNOWN', after: 'HEALTHY', events: [] },
    ]);
    expect(await tool('acme-node')).toMatchObject({ status: 'HEALTHY', transientStreak: 0 });
  });

  it('is idempotent: finishing again returns the stored result and applies nothing twice', async () => {
    await sync('acme-node');
    const { cycleId, res } = await cycle(0, passing('acme-node'));
    t.clock.now = new Date(BASE + 9 * DAY);
    const again = await finish(cycleId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(res.json());
    expect(await tool('acme-node')).toMatchObject({ consecutivePasses: 1 });
  });

  it('after it, the cycle takes no more runs (409)', async () => {
    await sync('acme-node');
    const { cycleId } = await cycle(0, passing('acme-node'));
    const late = await t.signed('/internal/runs', {
      runResult: pass(cycleId, 'acme-node', at(0, 5), { attempt: 2 }),
      logPaths: {},
    });
    expect(late.statusCode).toBe(409);
  });

  it('404 for an unknown cycle', async () => {
    expect((await finish('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

d('an INVALID cycle changes nothing', () => {
  it('a canary with the wrong result makes the cycle invalid: no transitions, one cycle_ignored note, a queue item', async () => {
    await sync('acme-node');
    const cycleId = await newCycle(0);
    const time = at(0, 1);
    const wrongCanary = fail(cycleId, 'canary-pass-node', DRIFT_STDERR, time); // should have passed
    await report([
      ...canaryResults(cycleId, time, { 'canary-pass-node': wrongCanary }),
      fail(cycleId, 'acme-node', DRIFT_STDERR, time),
    ]);
    const res = await finish(cycleId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      valid: false,
      canaryOk: false,
      tools: [],
      canaryProblems: ['canary-pass-node: expected PASS but got FAIL (API_DRIFT)'],
    });
    expect(res.json().ignored).toMatch(/cycle_ignored|not valid/);
    // the vendor's tool failed in this cycle, and nothing happened to it
    expect(await tool('acme-node')).toMatchObject({
      status: 'UNKNOWN',
      consecutiveFailures: 0,
      lastRunAt: null,
    });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    const [row] = await t.handle.db.select().from(probeCycles);
    expect(row).toMatchObject({ valid: false, canaryOk: false });
    expect(row?.finishedAt).not.toBeNull();
    expect((await t.handle.db.select().from(adminQueueItems)).map((i) => i.reason)).toEqual([
      'cycle_invalid',
    ]);
  });

  it('a canary that FAILS with the wrong class is wrong too', async () => {
    await sync('acme-node');
    const cycleId = await newCycle(0);
    const time = at(0, 1);
    const wrong = fail(cycleId, 'canary-fail-drift', TIMEOUT_STDERR, time); // fails, but as a transient error
    await report(canaryResults(cycleId, time, { 'canary-fail-drift': wrong }));
    const res = await finish(cycleId);
    expect(res.json().canaryProblems).toEqual([
      'canary-fail-drift: expected FAIL (API_DRIFT) but got FAIL (NETWORK_TRANSIENT)',
    ]);
    expect(res.json().valid).toBe(false);
  });

  it('a MISSING canary result makes the cycle invalid and names the canary', async () => {
    await sync('acme-node');
    const cycleId = await newCycle(0);
    const time = at(0, 1);
    await report([
      ...canaryResults(cycleId, time, { 'canary-fail-dep': null }),
      fail(cycleId, 'acme-node', DRIFT_STDERR, time),
    ]);
    const res = await finish(cycleId);
    expect(res.json()).toMatchObject({
      valid: false,
      canaryProblems: ['canary-fail-dep: no result in this cycle'],
      tools: [],
    });
    expect(await tool('acme-node')).toMatchObject({ status: 'UNKNOWN' });
  });

  it('a cycle with no results at all is invalid (a crashed plan job)', async () => {
    await sync('acme-node');
    const cycleId = await newCycle(0);
    const res = await finish(cycleId);
    expect(res.json()).toMatchObject({ valid: false });
    expect(res.json().canaryProblems).toHaveLength(4);
  });

  it('an invalid cycle does not break the streak of the cycles around it', async () => {
    await sync('acme-node');
    await cycle(0, failing('acme-node', DRIFT_STDERR)); // DEGRADED
    const bad = await newCycle(1);
    await report([
      ...canaryResults(bad, at(1, 1), { 'canary-pass-node': null }),
      fail(bad, 'acme-node', DRIFT_STDERR, at(1, 1)),
    ]);
    await finish(bad);
    expect(await tool('acme-node')).toMatchObject({ status: 'DEGRADED', consecutiveFailures: 1 });
    await cycle(2, failing('acme-node', DRIFT_STDERR)); // second valid failure, same signature
    expect(await tool('acme-node')).toMatchObject({ status: 'BROKEN', consecutiveFailures: 2 });
  });
});

d('incidents: open, confirm, resolve, recur', () => {
  it('two consecutive failures with the same signature in valid cycles open an incident; the first only degrades', async () => {
    await sync('acme-node');
    const first = await cycle(0, failing('acme-node', DRIFT_STDERR));
    expect(first.res.json().tools).toEqual([
      { slug: 'acme-node', before: 'UNKNOWN', after: 'DEGRADED', events: [] },
    ]);
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);

    const second = await cycle(
      1,
      failing('acme-node', DRIFT_STDERR.replace('/work/index.js:3:1', '/work/index.js:40:9')),
    );
    const entry = second.res.json().tools[0];
    expect(entry).toMatchObject({ slug: 'acme-node', before: 'DEGRADED', after: 'BROKEN' });
    expect(entry.events).toEqual([
      expect.objectContaining({
        type: 'incident_opened',
        failureClass: 'API_DRIFT',
        trigger: 'repeat_failure',
      }),
    ]);

    const [incident] = await t.handle.db.select().from(incidents);
    expect(incident).toMatchObject({
      state: 'OPEN',
      review: 'PENDING_REVIEW',
      failureClass: 'API_DRIFT',
      confirmedAt: null,
      resolvedAt: null,
    });
    expect(incident?.signature).toBe(entry.events[0].signature);
    const toolRow = await tool('acme-node');
    const [firstRun] = await t.handle.db.select().from(runs).where(eq(runs.cycleId, first.cycleId));
    const firstFailing = (
      await t.handle.db.select().from(runs).where(eq(runs.cycleId, first.cycleId))
    ).find((r) => r.toolId === toolRow?.id);
    expect(firstRun).toBeDefined();
    expect(incident?.firstFailingRunId).toBe(firstFailing?.id);
    expect(incident?.openedAt.toISOString()).toBe(at(1, 1));
    const events = await t.handle.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, (incident as { id: string }).id));
    expect(events.map((e) => e.type)).toEqual(['opened']);
    expect(await tool('acme-node')).toMatchObject({
      status: 'BROKEN',
      consecutiveFailures: 2,
      lastFailureClass: 'API_DRIFT',
    });
  });

  it('a second failure with a DIFFERENT signature restarts the streak: no incident', async () => {
    await sync('acme-node');
    await cycle(0, failing('acme-node', DRIFT_STDERR));
    const second = await cycle(
      1,
      failing('acme-node', 'TypeError: acme.otherThing is not a function\n'),
    );
    expect(second.res.json().tools[0]).toMatchObject({ before: 'DEGRADED', after: 'DEGRADED' });
    expect(await tool('acme-node')).toMatchObject({ consecutiveFailures: 1 });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
  });

  it('an internal BROKEN is public DEGRADED ("verifying") until an admin confirms it, then public BROKEN', async () => {
    await sync('acme-node');
    await cycle(0, failing('acme-node', DRIFT_STDERR));
    await cycle(1, failing('acme-node', DRIFT_STDERR));
    const publicStatus = async () =>
      (await t.handle.sql`select status from public_tools where slug = 'acme-node'`)[0]?.['status'];
    expect(await publicStatus()).toBe('DEGRADED');
    expect(await t.handle.sql`select 1 from public_incidents`).toHaveLength(0);
    const [incident] = await t.handle.db.select().from(incidents);
    const confirmed = await t.admin('POST', `/admin/incidents/${incident?.id}/confirm`, {
      summary: 'acme-sdk removed createClient',
      suggestedFix: 'use createAcmeClient',
    });
    expect(confirmed.statusCode).toBe(200);
    expect(await publicStatus()).toBe('BROKEN');
    expect(await t.handle.sql`select summary from public_incidents`).toMatchObject([
      { summary: 'acme-sdk removed createClient' },
    ]);
  });

  it('the tool recovers after TWO consecutive passes and the incident is resolved', async () => {
    await sync('acme-node');
    await cycle(0, failing('acme-node', DRIFT_STDERR));
    await cycle(1, failing('acme-node', DRIFT_STDERR));
    const one = await cycle(2, passing('acme-node'));
    expect(one.res.json().tools[0]).toMatchObject({
      before: 'BROKEN',
      after: 'BROKEN',
      events: [],
    });
    expect((await t.handle.db.select().from(incidents))[0]?.state).toBe('OPEN');
    const two = await cycle(3, passing('acme-node'));
    expect(two.res.json().tools[0]).toMatchObject({ before: 'BROKEN', after: 'HEALTHY' });
    expect(two.res.json().tools[0].events).toEqual([
      expect.objectContaining({ type: 'incident_resolved' }),
    ]);
    const [incident] = await t.handle.db.select().from(incidents);
    expect(incident).toMatchObject({ state: 'RESOLVED' });
    expect(incident?.resolvedAt?.toISOString()).toBe(at(3, 1));
    const events = await t.handle.db.select().from(incidentEvents).orderBy(asc(incidentEvents.id));
    expect(events.map((e) => e.type)).toEqual(['opened', 'resolved']);
    expect(await tool('acme-node')).toMatchObject({
      status: 'HEALTHY',
      lastFailureSignature: null,
      consecutiveFailures: 0,
    });
  });

  it('a failure with the signature of an incident resolved within 7 days reopens THAT incident immediately (recurred), awaiting review again', async () => {
    await sync('acme-node');
    await cycle(0, failing('acme-node', DRIFT_STDERR));
    await cycle(1, failing('acme-node', DRIFT_STDERR));
    const [original] = await t.handle.db.select().from(incidents);
    await t.admin('POST', `/admin/incidents/${original?.id}/confirm`, {
      summary: 's',
      suggestedFix: 'f',
    });
    await cycle(2, passing('acme-node'));
    await cycle(3, passing('acme-node'));
    const back = await cycle(5, failing('acme-node', DRIFT_STDERR)); // 2 days after the resolution
    expect(back.res.json().tools[0]).toMatchObject({ before: 'HEALTHY', after: 'BROKEN' });
    expect(back.res.json().tools[0].events).toEqual([
      expect.objectContaining({ type: 'incident_recurred', incidentId: original?.id }),
    ]);
    const all = await t.handle.db.select().from(incidents);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: original?.id,
      state: 'OPEN',
      review: 'PENDING_REVIEW',
      resolvedAt: null,
      confirmedAt: null,
    });
    const events = await t.handle.db.select().from(incidentEvents).orderBy(asc(incidentEvents.id));
    expect(events.map((e) => e.type)).toEqual(['opened', 'confirmed', 'resolved', 'recurred']);
  });

  it('after more than 7 days the same failure is an ordinary first failure again', async () => {
    await sync('acme-node');
    await cycle(0, failing('acme-node', DRIFT_STDERR));
    await cycle(1, failing('acme-node', DRIFT_STDERR));
    await cycle(2, passing('acme-node'));
    await cycle(3, passing('acme-node'));
    const late = await cycle(12, failing('acme-node', DRIFT_STDERR)); // 9 days after the resolution
    expect(late.res.json().tools[0]).toMatchObject({
      before: 'HEALTHY',
      after: 'DEGRADED',
      events: [],
    });
    expect((await t.handle.db.select().from(incidents))[0]?.state).toBe('RESOLVED');
  });

  it('a failure that changes shape while BROKEN adds a signature_changed event to the open incident', async () => {
    await sync('acme-node');
    await cycle(0, failing('acme-node', DRIFT_STDERR));
    await cycle(1, failing('acme-node', DRIFT_STDERR));
    const [incident] = await t.handle.db.select().from(incidents);
    const changed = await cycle(
      2,
      failing('acme-node', 'TypeError: acme.somethingElse is not a function\n'),
    );
    expect(changed.res.json().tools[0].events).toEqual([
      expect.objectContaining({ type: 'incident_signature_changed', incidentId: incident?.id }),
    ]);
    const [after] = await t.handle.db.select().from(incidents);
    expect(after?.signature).not.toBe(incident?.signature);
    expect(
      (await t.handle.db.select().from(incidentEvents).orderBy(asc(incidentEvents.id))).map(
        (e) => e.type,
      ),
    ).toEqual(['opened', 'signature_changed']);
  });

  it('4 transient failures in a row open an incident (likely a registry or vendor outage); 3 only degrade a HEALTHY tool', async () => {
    await sync('acme-node');
    await cycle(0, passing('acme-node'));
    const statuses: string[] = [];
    for (let day = 1; day <= 4; day++) {
      const { res } = await cycle(day, failing('acme-node', TIMEOUT_STDERR));
      statuses.push(res.json().tools[0].after);
    }
    expect(statuses).toEqual(['DEGRADED', 'DEGRADED', 'DEGRADED', 'BROKEN']);
    const [incident] = await t.handle.db.select().from(incidents);
    expect(incident).toMatchObject({
      failureClass: 'NETWORK_TRANSIENT',
      state: 'OPEN',
      review: 'PENDING_REVIEW',
    });
    expect(await tool('acme-node')).toMatchObject({ transientStreak: 4 });
  });

  it('spec row 5: a tool that is still UNKNOWN stays UNKNOWN through transient failures, and the 4th still opens the incident', async () => {
    await sync('acme-node');
    const statuses: string[] = [];
    for (let day = 0; day < 4; day++) {
      const { res } = await cycle(day, failing('acme-node', TIMEOUT_STDERR));
      statuses.push(res.json().tools[0].after);
    }
    expect(statuses).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'BROKEN']);
    expect(await t.handle.db.select().from(incidents)).toHaveLength(1);
  });

  it('a pass in the middle breaks the transient streak', async () => {
    await sync('acme-node');
    for (const make of [
      failing('acme-node', TIMEOUT_STDERR),
      failing('acme-node', TIMEOUT_STDERR),
      passing('acme-node'),
      failing('acme-node', TIMEOUT_STDERR),
      failing('acme-node', TIMEOUT_STDERR),
    ])
      await cycle((await t.handle.db.select().from(probeCycles)).length, make);
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
  });
});

d('things for a person: never an incident', () => {
  it('UNKNOWN, HARNESS_ERROR and a manual step go to the admin queue and leave the status alone', async () => {
    await sync('unknown-node', 'harness-node', 'manual-node');
    await cycle(0, (c, time) => [
      pass(c, 'unknown-node', time),
      pass(c, 'harness-node', time),
      pass(c, 'manual-node', time),
    ]);
    const { res } = await cycle(1, (c, time) => [
      fail(c, 'unknown-node', UNKNOWN_STDERR, time),
      stamp(
        runResult({
          cycleId: c,
          toolSlug: 'harness-node',
          outcome: 'HARNESS_ERROR',
          reachedLevel: 0,
          failedStepId: null,
          steps: [],
        }),
        time,
      ),
      stamp(
        runResult({
          cycleId: c,
          toolSlug: 'manual-node',
          outcome: 'SKIPPED',
          reachedLevel: 1,
          failedStepId: 's2',
          steps: [
            step('s1', 0, 'shell'),
            step('s2', 1, 'manual', {
              outcome: 'SKIPPED',
              exitCode: null,
              logFile: null,
              skipReason: 'manual_step',
            }),
          ],
        }),
        time,
      ),
    ]);
    for (const e of res.json().tools)
      expect(e, e.slug).toMatchObject({ before: 'HEALTHY', after: 'HEALTHY' });
    const reasons = (await t.handle.db.select().from(adminQueueItems)).map((i) => i.reason).sort();
    expect(reasons).toEqual(['harness_error', 'plan_regressed', 'unknown_failure']);
    expect(await t.handle.db.select().from(incidents)).toHaveLength(0);
    expect(await tool('unknown-node')).toMatchObject({ status: 'HEALTHY', consecutiveFailures: 0 });
  });

  it('retrying the finish does not queue the same item twice', async () => {
    await sync('unknown-node');
    const { cycleId } = await cycle(0, failing('unknown-node', UNKNOWN_STDERR));
    await finish(cycleId);
    expect(
      (await t.handle.db.select().from(adminQueueItems)).filter(
        (i) => i.reason === 'unknown_failure',
      ),
    ).toHaveLength(1);
  });
});

d('concurrent finish calls', () => {
  it('only one applies the transition: both get the same answer, one incident, the streak counted once', async () => {
    await sync('acme-node');
    await cycle(0, failing('acme-node', DRIFT_STDERR));
    const cycleId = await newCycle(1);
    const time = at(1, 1);
    await report([...canaryResults(cycleId, time), fail(cycleId, 'acme-node', DRIFT_STDERR, time)]);
    t.clock.now = new Date(Date.parse(time) + 60_000);
    const results = await Promise.all(Array.from({ length: 4 }, () => finish(cycleId)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    for (const r of results) expect(r.json()).toEqual(results[0]?.json());
    expect(results[0]?.json().tools[0]).toMatchObject({ before: 'DEGRADED', after: 'BROKEN' });
    expect(await t.handle.db.select().from(incidents)).toHaveLength(1);
    expect(await tool('acme-node')).toMatchObject({ consecutiveFailures: 2 });
    expect((await t.handle.db.select().from(incidentEvents)).map((e) => e.type)).toEqual([
      'opened',
    ]);
  });
});

d('after the commit: enrichment and revalidation (best effort)', () => {
  const extractionFor = (code: string, hash: string) => ({
    blocks: [
      {
        index: 0,
        kind: 'code',
        lang: 'js',
        text: code,
        filenameHint: 'index.js',
        headingPath: ['Quickstart'],
      },
    ],
    contentHash: hash,
  });
  async function snapshot(slug: string, code: string, hash: string): Promise<string> {
    const [toolRow] = await t.handle.db.select().from(tools).where(eq(tools.slug, slug));
    const [s] = await t.handle.db
      .insert(docSnapshots)
      .values({
        toolId: (toolRow as { id: string }).id,
        contentHash: hash,
        extraction: extractionFor(code, hash),
      })
      .returning({ id: docSnapshots.id });
    void s;
    return hash;
  }
  const resolved = (version: string) => ({
    runnerEnv: {
      node: 'v22.1.0',
      resolved: JSON.stringify({ 'acme-sdk': version, left: '1.0.0' }),
    },
  });

  async function brokenWithHistory() {
    await sync('acme-node');
    const before = await snapshot('acme-node', 'const c = acme.createClient();', 'a'.repeat(64));
    const after = await snapshot('acme-node', 'const c = acme.createAcmeClient();', 'b'.repeat(64));
    await cycle(0, (c, time) => [
      pass(c, 'acme-node', time, { snapshotHash: before, ...resolved('1.0.0') }),
    ]);
    await cycle(1, (c, time) => [
      fail(c, 'acme-node', DRIFT_STDERR, time, { snapshotHash: after, ...resolved('2.0.0') }),
    ]);
    return cycle(2, (c, time) => [
      fail(c, 'acme-node', DRIFT_STDERR, time, { snapshotHash: after, ...resolved('2.0.0') }),
    ]);
  }

  it('records the docs diff, the version diff and an LLM-drafted summary on the new incident, never published', async () => {
    t.llm.push(
      JSON.stringify({
        summary: 'acme-sdk 2.0.0 renamed createClient.',
        suggestedFix: 'Call createAcmeClient.',
      }),
    );
    await brokenWithHistory();
    const [incident] = await t.handle.db.select().from(incidents);
    expect(incident?.docsChanged).toBe(true);
    expect(incident?.docsDiffPath).toMatch(/^diffs\/[0-9a-f-]+-[0-9a-f]{24}\.diff$/);
    const put = t.storage.puts.find((p) => p.path === incident?.docsDiffPath);
    expect(put).toMatchObject({ bucket: 'public-artifacts', contentType: 'text/x-diff' });
    expect(put?.body).toContain('-const c = acme.createClient();');
    expect(put?.body).toContain('+const c = acme.createAcmeClient();');
    expect(incident?.versionDiff).toEqual({
      changed: [{ name: 'acme-sdk', from: '1.0.0', to: '2.0.0' }],
      added: [],
      removed: [],
    });
    expect(incident).toMatchObject({
      summary: 'acme-sdk 2.0.0 renamed createClient.',
      suggestedFix: 'Call createAcmeClient.',
      review: 'PENDING_REVIEW',
    });
    expect((await t.handle.db.select().from(llmCalls)).map((c) => c.purpose)).toEqual([
      'summarize',
    ]);
    // the draft prompt is built from data the page and the logs produced: it says so
    expect(t.llm.requests[0]?.[0]?.content).toMatch(/untrusted/i);
    // not public until an admin confirms
    expect(await t.handle.sql`select 1 from public_incidents`).toHaveLength(0);
  });

  it('the same docs hash on both sides: docs_changed false and no diff file', async () => {
    t.llm.push(JSON.stringify({ summary: 's', suggestedFix: 'f' }));
    await sync('acme-node');
    const same = await snapshot('acme-node', 'x()', 'c'.repeat(64));
    await cycle(0, (c, time) => [pass(c, 'acme-node', time, { snapshotHash: same })]);
    await cycle(1, (c, time) => [fail(c, 'acme-node', DRIFT_STDERR, time, { snapshotHash: same })]);
    await cycle(2, (c, time) => [fail(c, 'acme-node', DRIFT_STDERR, time, { snapshotHash: same })]);
    const [incident] = await t.handle.db.select().from(incidents);
    expect(incident).toMatchObject({ docsChanged: false, docsDiffPath: null });
    expect(t.storage.puts).toHaveLength(0);
  });

  it('a failed enrichment (model error) leaves an admin queue item and never blocks the status', async () => {
    t.llm.push(new Error('groq is down'));
    const { res } = await brokenWithHistory();
    expect(res.statusCode).toBe(200);
    expect(await tool('acme-node')).toMatchObject({ status: 'BROKEN' });
    const [incident] = await t.handle.db.select().from(incidents);
    expect(incident?.summary).toBeNull();
    expect(incident?.docsDiffPath).not.toBeNull(); // the parts that worked were kept
    const items = await t.handle.db.select().from(adminQueueItems);
    expect(items.filter((i) => i.reason === 'enrichment_failed')).toMatchObject([
      { incidentId: incident?.id, detail: { failed: ['summary'] } },
    ]);
  });

  it('a failed storage upload is also just a queue item', async () => {
    t.storage.failPut = true;
    t.llm.push(JSON.stringify({ summary: 's', suggestedFix: 'f' }));
    const { res } = await brokenWithHistory();
    expect(res.statusCode).toBe(200);
    const [incident] = await t.handle.db.select().from(incidents);
    expect(incident).toMatchObject({ docsChanged: true, docsDiffPath: null, summary: 's' });
    expect(
      (await t.handle.db.select().from(adminQueueItems)).find(
        (i) => i.reason === 'enrichment_failed',
      )?.detail,
    ).toMatchObject({ failed: ['docs_diff'] });
    t.storage.failPut = false;
  });

  it('the summary draft respects the token budget: out of budget is a queue item, not a call', async () => {
    await t.handle.db.insert(llmCalls).values({
      purpose: 'compile',
      model: 'm',
      tokensIn: 149_990,
      tokensOut: 0,
      latencyMs: 1,
      ok: true,
      createdAt: new Date(BASE + 2 * DAY),
    });
    t.llm.push(JSON.stringify({ summary: 's', suggestedFix: 'f' }));
    await brokenWithHistory();
    expect(t.llm.calls).toBe(0);
    const [incident] = await t.handle.db.select().from(incidents);
    expect(incident?.summary).toBeNull();
    expect(
      (await t.handle.db.select().from(adminQueueItems)).find(
        (i) => i.reason === 'enrichment_failed',
      )?.detail,
    ).toMatchObject({ failed: ['summary'] });
  });

  it('with no model configured the draft is simply skipped', async () => {
    const quiet = await startTestApp(dbUrl as string, { llm: null });
    const original = t;
    t = quiet;
    try {
      await resetDb(quiet.handle);
      await brokenWithHistory();
      const [incident] = await quiet.handle.db.select().from(incidents);
      expect(incident?.summary).toBeNull();
      expect(
        (await quiet.handle.db.select().from(adminQueueItems)).filter(
          (i) => i.reason === 'enrichment_failed',
        ),
      ).toHaveLength(0);
    } finally {
      t = original;
      await quiet.close();
    }
  });

  it('calls the web revalidation hook after a valid cycle, with the secret, and survives its failure', async () => {
    const hooked = await startTestApp(dbUrl as string, {
      config: {
        REVALIDATE_URL: 'https://web.example/api/revalidate',
        REVALIDATE_SECRET: 'revalidate-secret-0123456789',
      },
    });
    const original = t;
    t = hooked;
    try {
      await resetDb(hooked.handle);
      await sync('acme-node');
      hooked.fetchReplies.push(new Error('web is down'));
      const { res } = await cycle(0, passing('acme-node'));
      expect(res.statusCode).toBe(200);
      expect(hooked.fetchCalls).toHaveLength(1);
      expect(hooked.fetchCalls[0]?.url).toBe('https://web.example/api/revalidate');
      expect(JSON.stringify(hooked.fetchCalls[0]?.init?.headers)).toContain(
        'revalidate-secret-0123456789',
      );
      expect(hooked.logs.join('')).not.toContain('revalidate-secret-0123456789');
    } finally {
      t = original;
      await hooked.close();
    }
  });

  it('does not call the hook for an invalid cycle (nothing changed)', async () => {
    const hooked = await startTestApp(dbUrl as string, {
      config: {
        REVALIDATE_URL: 'https://web.example/api/revalidate',
        REVALIDATE_SECRET: 'revalidate-secret-0123456789',
      },
    });
    await hooked.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const cycleId = (
      await hooked.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' })
    ).json().cycleId;
    await hooked.signed(`/internal/cycles/${cycleId}/finish`);
    expect(hooked.fetchCalls).toHaveLength(0);
    await hooked.close();
  });
});
