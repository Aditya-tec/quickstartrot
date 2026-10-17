import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { LaunchExport } from '@qsr/core';
import { incidents, probeCycles, runs, tools } from '@qsr/db';
import { FIXED_NOW, resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// GET /admin/export/launch (P9a): the numbers for a launch post. Only incidents a person REVIEWED AND CONFIRMED may
// appear in it, not even as a count: the seed holds a pending and a false-positive incident with distinctive text.

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
  const slugs = ['alpha-node', 'beta-node', 'gamma-python', 'never-node', 'canary-pass-node'];
  await t.signed('/internal/targets/sync', {
    targets: slugs.map((s) => targetInput(s, { level: 3 })),
  });
  const id: Record<string, string> = {};
  for (const row of await db().select().from(tools)) id[row.slug] = row.id;
  const cycle = async (startedAgo: number, valid: boolean | null = true) =>
    (
      await db()
        .insert(probeCycles)
        .values({
          trigger: 'cron',
          gitSha: 'abcdef1234567',
          startedAt: ago(startedAgo),
          finishedAt: valid === null ? null : ago(startedAgo - 20 * 60_000),
          valid,
          canaryOk: valid,
        })
        .returning({ id: probeCycles.id })
    )[0]?.id as string;
  const c1 = await cycle(6 * DAY);
  const c2 = await cycle(5 * DAY);
  const c3 = await cycle(4 * DAY);
  await cycle(3 * DAY, false);
  let n = 0;
  const run = async (
    cycleId: string,
    startedAgo: number,
    slug: string,
    over: Partial<typeof runs.$inferInsert> = {},
  ) => {
    n += 1;
    return (
      await db()
        .insert(runs)
        .values({
          cycleId,
          toolId: id[slug] as string,
          attempt: 1,
          outcome: 'PASS',
          reachedLevel: 3,
          imageDigest: 'sha256:' + 'a'.repeat(64),
          runnerEnv: {},
          durationMs: 5000,
          startedAt: ago(startedAgo - n * 1000),
          finishedAt: ago(startedAgo - n * 1000 - 3000),
          ...over,
        })
        .returning({ id: runs.id })
    )[0]?.id as string;
  };
  for (const [c, a] of [
    [c1, 6],
    [c2, 5],
    [c3, 4],
  ] as const) {
    await run(c, a * DAY, 'alpha-node');
    await run(c, a * DAY, 'canary-pass-node');
  }
  const betaFirstFail = await run(c1, 6 * DAY, 'beta-node', {
    outcome: 'FAIL',
    failureClass: 'API_DRIFT',
    reachedLevel: 2,
  });
  await run(c2, 5 * DAY, 'beta-node', {
    outcome: 'FAIL',
    failureClass: 'API_DRIFT',
    reachedLevel: 2,
  });
  await run(c3, 4 * DAY, 'beta-node', {
    outcome: 'FAIL',
    failureClass: 'API_DRIFT',
    reachedLevel: 2,
  });
  await run(c1, 6 * DAY, 'gamma-python', { reachedLevel: 1 });
  const alphaFirstFail = await run(c3, 4 * DAY, 'alpha-node', {
    outcome: 'FAIL',
    failureClass: 'DEPENDENCY_RESOLUTION',
    attempt: 2,
  }); // same cycle, a later attempt of alpha

  await db()
    .insert(incidents)
    .values([
      // confirmed: docs AND dependency changed; detected 24 h after the first failing run, confirmed 3 h later
      {
        toolId: id['beta-node'] as string,
        signature: 'b1',
        failureClass: 'API_DRIFT',
        state: 'OPEN',
        review: 'CONFIRMED',
        openedAt: ago(5 * DAY),
        confirmedAt: ago(5 * DAY - 3 * HOUR),
        firstFailingRunId: betaFirstFail,
        docsChanged: true,
        versionDiff: {
          changed: [{ name: 'acme', from: '1.0.0', to: '2.0.0' }],
          added: [],
          removed: [],
        },
        summary: 'Reviewed: acme 2.0 removed client.send.',
        suggestedFix: 'Use client.emails.send.',
        docsDiffPath: 'diffs/beta.diff',
      },
      // confirmed: dependency only, detected 12 h after, confirmed 1 h later, already resolved
      {
        toolId: id['alpha-node'] as string,
        signature: 'a1',
        failureClass: 'DEPENDENCY_RESOLUTION',
        state: 'RESOLVED',
        review: 'CONFIRMED',
        openedAt: ago(4 * DAY - 12 * HOUR),
        confirmedAt: ago(4 * DAY - 13 * HOUR),
        resolvedAt: ago(2 * DAY),
        firstFailingRunId: alphaFirstFail,
        docsChanged: false,
        versionDiff: { changed: [], added: [{ name: 'x', version: '1' }], removed: [] },
        summary: 'Reviewed: a transitive dependency was removed.',
        suggestedFix: null,
      },
      // NOT confirmed: must appear nowhere, not even in a count
      {
        toolId: id['gamma-python'] as string,
        signature: 'g1',
        failureClass: 'DOCS_SNIPPET_ERROR',
        state: 'OPEN',
        review: 'PENDING_REVIEW',
        openedAt: ago(HOUR),
        docsChanged: true,
        summary: 'POISON-PENDING-SUMMARY',
        suggestedFix: 'POISON-PENDING-FIX',
      },
      {
        toolId: id['gamma-python'] as string,
        signature: 'g2',
        failureClass: 'NETWORK_TRANSIENT',
        state: 'RESOLVED',
        review: 'FALSE_POSITIVE',
        openedAt: ago(2 * DAY),
        resolvedAt: ago(2 * DAY),
        summary: 'POISON-FALSE-POSITIVE-SUMMARY',
      },
    ]);
  void eq;
  return { betaFirstFail, alphaFirstFail };
}

const exportLaunch = async () => {
  const res = await t.admin('GET', '/admin/export/launch');
  expect(res.statusCode, res.body).toBe(200);
  return { text: res.body, data: LaunchExport.parse(res.json()) };
};

d('GET /admin/export/launch', () => {
  it('requires the admin token', async () => {
    expect(
      (await t.admin('GET', '/admin/export/launch', undefined, 'wrong-token-wrong-token-wrong'))
        .statusCode,
    ).toBe(401);
  });

  it('counts tracked tools by the level their latest run reached, and the ones that never ran', async () => {
    await seed();
    const { data } = await exportLaunch();
    expect(data.tools).toEqual({
      tracked: 4,
      testedAtL3: 1,
      testedAtL2: 1,
      testedAtL1: 1,
      notYetRun: 1,
    });
  });

  it('counts valid and invalid cycles and the time they span', async () => {
    await seed();
    const { data } = await exportLaunch();
    expect(data.cycles.valid).toBe(3);
    expect(data.cycles.invalid).toBe(1);
    expect(data.cycles.firstAt).not.toBeNull();
    expect(Date.parse(data.cycles.lastAt as string)).toBeGreaterThan(
      Date.parse(data.cycles.firstAt as string),
    );
  });

  it('counts the runs of real tools in valid cycles, per tool (canaries are not tools)', async () => {
    await seed();
    const { data } = await exportLaunch();
    expect(data.runs.perTool.map((x) => x.slug)).toEqual([
      'alpha-node',
      'beta-node',
      'gamma-python',
    ]);
    expect(data.runs.perTool.find((x) => x.slug === 'alpha-node')).toEqual({
      slug: 'alpha-node',
      runs: 3,
      passes: 2,
      fails: 1,
    });
    expect(data.runs.total).toBe(3 + 3 + 1);
  });

  it('describes only the confirmed incidents: class counts, what changed, and how fast they were found', async () => {
    await seed();
    const { data } = await exportLaunch();
    expect(data.incidents.confirmed).toBe(2);
    expect(data.incidents.byFailureClass).toEqual({ API_DRIFT: 1, DEPENDENCY_RESOLUTION: 1 });
    expect(data.incidents.coincidence).toEqual({
      docsOnly: 0,
      dependencyOnly: 1,
      both: 1,
      neither: 0,
      unknown: 0,
    });
    // 24 h and 12 h to detect: the median of two is their mean; 3 h and 1 h to confirm: 2 h
    expect(data.incidents.medianHoursToDetect).toBeCloseTo(18, 0);
    expect(data.incidents.medianHoursToConfirm).toBeCloseTo(2, 5);
  });

  it('lists each confirmed incident with its reviewed text and its evidence as site paths', async () => {
    const { betaFirstFail } = await seed();
    const { data } = await exportLaunch();
    const beta = data.incidents.list.find((i) => i.slug === 'beta-node');
    expect(beta).toMatchObject({
      review: 'CONFIRMED',
      summary: 'Reviewed: acme 2.0 removed client.send.',
      suggestedFix: 'Use client.emails.send.',
      docsChanged: true,
      dependencyChanged: true,
      toolPath: '/tools/beta-node',
      firstFailingRunPath: `/runs/${betaFirstFail}`,
      docsDiffPath: 'diffs/beta.diff',
    });
    expect(data.incidents.list).toHaveLength(2);
  });

  it('NEVER includes an incident that is not confirmed: no text, no count, no trace', async () => {
    await seed();
    const { text, data } = await exportLaunch();
    for (const needle of [
      'POISON-PENDING',
      'POISON-FALSE-POSITIVE',
      'PENDING_REVIEW',
      'FALSE_POSITIVE',
      'g1',
      'g2',
    ])
      expect(text, needle).not.toContain(needle);
    expect(data.incidents.list.every((i) => i.review === 'CONFIRMED')).toBe(true);
    expect(data.incidents.confirmed).toBe(data.incidents.list.length);
  });

  it('an empty database gives zeros, not an error', async () => {
    const { data } = await exportLaunch();
    expect(data.tools.tracked).toBe(0);
    expect(data.incidents).toMatchObject({ confirmed: 0, list: [], medianHoursToDetect: null });
    expect(data.cycles.firstAt).toBeNull();
  });
});
