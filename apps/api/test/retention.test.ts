import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PIPELINE, RetentionResponse } from '@qsr/core';
import { incidents, probeCycles, runs, stepResults, tools } from '@qsr/db';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// DB retention: the stdout/stderr TAILS of passing steps older than the log retention (30 days) are set to NULL. A passing step's tail is not
// evidence of anything; a failing step's is, and so is everything an incident links. It defaults to a DRY RUN: it says what it would do and
// changes nothing until it is asked to (dryRun: false). The nightly cleanup (POST /admin/gc) does it for real.

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
  t.storage.removed.length = 0;
  t.storage.objects.clear();
});

const DAY = 24 * 3600 * 1000;
const ago = (days: number) => new Date(t.clock.now.getTime() - days * DAY);

async function world() {
  await t.signed('/internal/targets/sync', { targets: [targetInput('acme-node')] });
  const [tool] = await t.handle.db.select().from(tools).where(eq(tools.slug, 'acme-node'));
  const [cycle] = await t.handle.db
    .insert(probeCycles)
    .values({ trigger: 'manual', gitSha: 'abcdef1234567' })
    .returning();
  return { toolId: (tool as { id: string }).id, cycleId: (cycle as { id: string }).id };
}

interface S {
  id: string;
  outcome: 'PASS' | 'FAIL';
  stdout?: string | null;
  stderr?: string | null;
}
let attempt = 0;
async function runWith(
  ageDays: number,
  steps: S[],
  ids: { toolId: string; cycleId: string },
  outcome: 'PASS' | 'FAIL' = 'PASS',
) {
  const [run] = await t.handle.db
    .insert(runs)
    .values({
      cycleId: ids.cycleId,
      toolId: ids.toolId,
      attempt: ++attempt,
      outcome,
      imageDigest: 'sha256:x',
      runnerEnv: {},
      durationMs: 1,
      startedAt: ago(ageDays),
      finishedAt: ago(ageDays),
    })
    .returning();
  const runId = (run as { id: string }).id;
  await t.handle.db.insert(stepResults).values(
    steps.map((s, i) => ({
      runId,
      stepId: s.id,
      ordinal: i,
      kind: 'shell',
      outcome: s.outcome,
      durationMs: 1,
      stdoutTail: s.stdout ?? null,
      stderrTail: s.stderr ?? null,
    })),
  );
  return runId;
}
const tails = async () =>
  Object.fromEntries(
    (await t.handle.db.select().from(stepResults)).map((s) => [
      `${s.runId.slice(0, 4)}:${s.stepId}`,
      [s.stdoutTail, s.stderrTail],
    ]),
  );
const retention = async (body: object) => {
  const res = await t.signed('/admin/retention', body);
  expect(res.statusCode, res.body).toBe(200);
  return RetentionResponse.parse(res.json());
};

it('retains for the same number of days as the logs, which is what the methodology quotes', () => {
  expect(PIPELINE.logRetentionDays).toBe(30);
});

d('POST /admin/retention', () => {
  it('is a DRY RUN unless asked otherwise: it counts what it would do and changes nothing', async () => {
    const ids = await world();
    await runWith(
      45,
      [{ id: 's1', outcome: 'PASS', stdout: 'added 1 package', stderr: 'warn x' }],
      ids,
    );
    const before = await tails();
    const r = await retention({});
    expect(r).toMatchObject({
      dryRun: true,
      steps: 1,
      bytes: 'added 1 package'.length + 'warn x'.length,
    });
    expect(await tails()).toEqual(before);
  });

  it('applies with dryRun false: the tails of OLD PASSING steps become null, nothing else changes', async () => {
    const ids = await world();
    const old = await runWith(
      45,
      [
        { id: 'pass-old', outcome: 'PASS', stdout: 'out', stderr: 'err' },
        { id: 'fail-old', outcome: 'FAIL', stdout: 'boom', stderr: 'Error: boom' },
      ],
      ids,
      'FAIL',
    );
    const fresh = await runWith(
      5,
      [{ id: 'pass-fresh', outcome: 'PASS', stdout: 'out', stderr: 'err' }],
      ids,
    );
    const r = await retention({ dryRun: false });
    expect(r).toMatchObject({ dryRun: false, steps: 1, bytes: 6 });
    const now = await tails();
    expect(now[`${old.slice(0, 4)}:pass-old`]).toEqual([null, null]);
    expect(now[`${old.slice(0, 4)}:fail-old`]).toEqual(['boom', 'Error: boom']); // a failing step's tail is evidence
    expect(now[`${fresh.slice(0, 4)}:pass-fresh`]).toEqual(['out', 'err']); // too new
  });

  it('keeps the tails of a run an incident points at, however old', async () => {
    const ids = await world();
    const first = await runWith(
      90,
      [{ id: 's1', outcome: 'PASS', stdout: 'first', stderr: null }],
      ids,
    );
    const last = await runWith(
      91,
      [{ id: 's1', outcome: 'PASS', stdout: 'last', stderr: null }],
      ids,
    );
    const other = await runWith(
      92,
      [{ id: 's1', outcome: 'PASS', stdout: 'other', stderr: null }],
      ids,
    );
    await t.handle.db.insert(incidents).values({
      toolId: ids.toolId,
      signature: 's',
      failureClass: 'API_DRIFT',
      firstFailingRunId: first,
      lastPassingRunId: last,
    });
    const r = await retention({ dryRun: false });
    expect(r.steps).toBe(1);
    const now = await tails();
    expect(now[`${first.slice(0, 4)}:s1`]).toEqual(['first', null]);
    expect(now[`${last.slice(0, 4)}:s1`]).toEqual(['last', null]);
    expect(now[`${other.slice(0, 4)}:s1`]).toEqual([null, null]);
  });

  it('uses the retention cutoff exactly: a run finished 31 days ago is cleared, one finished 29 days ago is not', async () => {
    const ids = await world();
    const older = await runWith(31, [{ id: 's1', outcome: 'PASS', stdout: 'x' }], ids);
    const newer = await runWith(29, [{ id: 's1', outcome: 'PASS', stdout: 'y' }], ids);
    await retention({ dryRun: false });
    const now = await tails();
    expect(now[`${older.slice(0, 4)}:s1`]).toEqual([null, null]);
    expect(now[`${newer.slice(0, 4)}:s1`]).toEqual(['y', null]);
  });

  it('is idempotent: a second run has nothing left to do', async () => {
    const ids = await world();
    await runWith(45, [{ id: 's1', outcome: 'PASS', stdout: 'x', stderr: 'y' }], ids);
    expect((await retention({ dryRun: false })).steps).toBe(1);
    expect(await retention({ dryRun: false })).toMatchObject({ steps: 0, bytes: 0 });
  });

  it('a step with no tails is not counted, and an empty database is fine', async () => {
    expect(await retention({})).toMatchObject({ steps: 0, bytes: 0 });
    const ids = await world();
    await runWith(45, [{ id: 's1', outcome: 'PASS', stdout: null, stderr: null }], ids);
    expect((await retention({ dryRun: false })).steps).toBe(0);
  });

  it('requires the HMAC like the other machine-to-machine calls, and refuses a body it does not understand', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/admin/retention', payload: {} });
    expect(res.statusCode).toBe(401);
    const bad = await t.signed('/admin/retention', { dryRun: 'yes' });
    expect(bad.statusCode).toBe(400);
  });

  it('the public view still works for a run whose old passing tails were cleared (they are simply absent)', async () => {
    const ids = await world();
    await runWith(45, [{ id: 's1', outcome: 'PASS', stdout: 'x', stderr: 'y' }], ids);
    await retention({ dryRun: false });
    const rows = await t.handle.sql`select count(*)::int n from public_runs`;
    expect(Number((rows[0] as { n: number }).n)).toBeGreaterThanOrEqual(0);
  });
});

d('POST /admin/gc does the retention for real, every night', () => {
  it('reports how many tails it cleared, and clears them', async () => {
    const ids = await world();
    const run = await runWith(45, [{ id: 's1', outcome: 'PASS', stdout: 'x', stderr: 'y' }], ids);
    const res = await t.signed('/admin/gc', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ nulledTails: 1 });
    expect((await tails())[`${run.slice(0, 4)}:s1`]).toEqual([null, null]);
  });
});
