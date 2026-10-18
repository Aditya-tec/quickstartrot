import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PIPELINE } from '@qsr/core';
import { incidents, probeCycles, runs, stepResults, tools } from '@qsr/db';
import { LOG_RETENTION_DAYS, TRACE_RETENTION_DAYS } from '../src/services/gc.js';
import { PRIVATE_BUCKET, PUBLIC_BUCKET } from '../src/storage.js';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// POST /admin/gc (spec section 5, "Storage"): HMAC, called by the nightly workflow. Step logs and docs diffs
// live 30 days unless an incident links them; Playwright traces live 14 days.

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

it('retains logs and traces for the days the methodology quotes', () => {
  expect(LOG_RETENTION_DAYS).toBe(PIPELINE.logRetentionDays);
  expect(TRACE_RETENTION_DAYS).toBe(PIPELINE.traceRetentionDays);
});
const ago = (days: number) => new Date(t.clock.now.getTime() - days * DAY);

let attemptCounter = 0;
async function runWithLog(label: string, ageDays: number, toolId: string, cycleId: string) {
  const [run] = await t.handle.db
    .insert(runs)
    .values({
      cycleId,
      toolId,
      attempt: ++attemptCounter,
      outcome: 'FAIL',
      imageDigest: 'sha256:x',
      runnerEnv: {},
      durationMs: 1,
      startedAt: ago(ageDays),
      finishedAt: ago(ageDays),
    })
    .returning();
  await t.handle.db.insert(stepResults).values({
    runId: (run as { id: string }).id,
    stepId: 's1',
    ordinal: 0,
    kind: 'shell',
    outcome: 'FAIL',
    durationMs: 1,
    logPath: `logs/${label}/00-s1.log.gz`,
  });
  return (run as { id: string }).id;
}

async function world() {
  await t.signed('/internal/targets/sync', { targets: [targetInput('acme-node')] });
  const [tool] = await t.handle.db.select().from(tools).where(eq(tools.slug, 'acme-node'));
  const [cycle] = await t.handle.db
    .insert(probeCycles)
    .values({ trigger: 'manual', gitSha: 'abcdef1234567' })
    .returning();
  return { toolId: (tool as { id: string }).id, cycleId: (cycle as { id: string }).id };
}
const logPaths = async () =>
  (await t.handle.db.select().from(stepResults)).map((s) => [s.logPath]).flat();

d('POST /admin/gc', () => {
  it('deletes logs older than 30 days and keeps newer ones', async () => {
    const { toolId, cycleId } = await world();
    await runWithLog('old', 45, toolId, cycleId);
    await runWithLog('fresh', 5, toolId, cycleId);
    const res = await t.signed('/admin/gc', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      freedBytes: null,
      deletedLogs: 1,
      deletedDiffs: 0,
      deletedTraces: 0,
      nulledTails: 0,
    });
    expect(t.storage.removed).toEqual([
      { bucket: PUBLIC_BUCKET, paths: ['logs/old/00-s1.log.gz'] },
    ]);
    expect((await logPaths()).sort()).toEqual(['logs/fresh/00-s1.log.gz', null]);
  });

  it('keeps the logs of a run an incident points at, however old', async () => {
    const { toolId, cycleId } = await world();
    const first = await runWithLog('first-failing', 90, toolId, cycleId);
    const last = await runWithLog('last-passing', 91, toolId, cycleId);
    await runWithLog('unlinked', 92, toolId, cycleId);
    await t.handle.db.insert(incidents).values({
      toolId,
      signature: 's',
      failureClass: 'API_DRIFT',
      firstFailingRunId: first,
      lastPassingRunId: last,
    });
    const res = await t.signed('/admin/gc', {});
    expect(res.json().deletedLogs).toBe(1);
    expect(t.storage.removed[0]?.paths).toEqual(['logs/unlinked/00-s1.log.gz']);
    expect((await logPaths()).filter(Boolean).sort()).toEqual([
      'logs/first-failing/00-s1.log.gz',
      'logs/last-passing/00-s1.log.gz',
    ]);
  });

  it("removes the docs diff of a false-positive incident after 30 days, keeps every other incident's", async () => {
    const { toolId } = await world();
    const diff = (
      path: string,
      review: 'FALSE_POSITIVE' | 'CONFIRMED' | 'PENDING_REVIEW',
      days: number,
    ) =>
      t.handle.db.insert(incidents).values({
        toolId,
        signature: path,
        failureClass: 'API_DRIFT',
        state: review === 'FALSE_POSITIVE' ? 'RESOLVED' : 'RESOLVED',
        review,
        docsDiffPath: path,
        openedAt: ago(days),
        resolvedAt: ago(days),
      });
    await diff('diffs/old-fp.diff', 'FALSE_POSITIVE', 40);
    await diff('diffs/fresh-fp.diff', 'FALSE_POSITIVE', 3);
    await diff('diffs/old-confirmed.diff', 'CONFIRMED', 400);
    const res = await t.signed('/admin/gc', {});
    expect(res.json().deletedDiffs).toBe(1);
    expect(t.storage.removed).toEqual([{ bucket: PUBLIC_BUCKET, paths: ['diffs/old-fp.diff'] }]);
    const rows = await t.handle.db.select().from(incidents);
    expect(rows.map((r) => r.docsDiffPath).sort()).toEqual([
      'diffs/fresh-fp.diff',
      'diffs/old-confirmed.diff',
      null,
    ]);
  });

  it('deletes traces older than 14 days from the private bucket', async () => {
    await world();
    t.storage.objects.set(`${PRIVATE_BUCKET}/traces`, [
      { name: 'traces/old.zip', updatedAt: ago(20).toISOString(), size: 10 },
      { name: 'traces/fresh.zip', updatedAt: ago(2).toISOString(), size: 10 },
    ]);
    const res = await t.signed('/admin/gc', {});
    expect(res.json().deletedTraces).toBe(1);
    expect(t.storage.removed).toEqual([{ bucket: PRIVATE_BUCKET, paths: ['traces/old.zip'] }]);
  });

  it('an empty database and an empty bucket are a no-op, and a repeat run deletes nothing more', async () => {
    expect((await t.signed('/admin/gc', {})).json()).toEqual({
      freedBytes: 0, // nothing was removed, so nothing was freed (known even without Storage metadata)
      deletedLogs: 0,
      deletedDiffs: 0,
      deletedTraces: 0,
      nulledTails: 0,
    });
    const { toolId, cycleId } = await world();
    await runWithLog('old', 45, toolId, cycleId);
    await t.signed('/admin/gc', {});
    expect((await t.signed('/admin/gc', {})).json().deletedLogs).toBe(0);
  });

  describe('how much it freed', () => {
    // Supabase keeps object metadata (with the size) in storage.objects of the same database; the test Postgres has
    // no such schema, so these tests create a minimal one and remove it again.
    async function withStorageSchema(fn: () => Promise<void>) {
      await t.handle.db.execute(sql`create schema if not exists storage`);
      await t.handle.db.execute(
        sql`create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null, metadata jsonb)`,
      );
      try {
        await fn();
      } finally {
        await t.handle.db.execute(sql`drop schema storage cascade`);
      }
    }
    const object = (bucket: string, name: string, size: number) =>
      t.handle.db.execute(
        sql`insert into storage.objects (bucket_id, name, metadata) values (${bucket}, ${name}, ${JSON.stringify({ size })}::jsonb)`,
      );

    it('adds up the sizes of the logs and traces it deleted, and counts nothing it kept', async () => {
      await withStorageSchema(async () => {
        const { toolId, cycleId } = await world();
        await runWithLog('old', 45, toolId, cycleId);
        await runWithLog('fresh', 5, toolId, cycleId);
        await object(PUBLIC_BUCKET, 'logs/old/00-s1.log.gz', 1_500);
        await object(PUBLIC_BUCKET, 'logs/fresh/00-s1.log.gz', 9_999);
        t.storage.objects.set(`${PRIVATE_BUCKET}/traces`, [
          { name: 'traces/old.zip', updatedAt: ago(20).toISOString(), size: 4_000 },
          { name: 'traces/fresh.zip', updatedAt: ago(2).toISOString(), size: 7_000 },
        ]);
        const res = (await t.signed('/admin/gc', {})).json();
        expect(res).toEqual({
          freedBytes: 5_500,
          deletedLogs: 1,
          deletedDiffs: 0,
          deletedTraces: 1,
          nulledTails: 0,
        });
      });
    });

    it('counts the docs diffs of false positives too', async () => {
      await withStorageSchema(async () => {
        const { toolId } = await world();
        await t.handle.db.insert(incidents).values({
          toolId,
          signature: 'fp',
          failureClass: 'API_DRIFT',
          state: 'RESOLVED',
          review: 'FALSE_POSITIVE',
          docsDiffPath: 'diffs/old-fp.diff',
          openedAt: ago(40),
          resolvedAt: ago(40),
        });
        await object(PUBLIC_BUCKET, 'diffs/old-fp.diff', 321);
        expect((await t.signed('/admin/gc', {})).json().freedBytes).toBe(321);
      });
    });

    it('is zero, not unknown, when the sizes can be read and nothing was old enough', async () => {
      await withStorageSchema(async () => {
        await world();
        expect((await t.signed('/admin/gc', {})).json()).toMatchObject({
          freedBytes: 0,
          deletedLogs: 0,
        });
      });
    });

    it('measures before deleting: the size is read while the object still exists', async () => {
      await withStorageSchema(async () => {
        const { toolId, cycleId } = await world();
        await runWithLog('old', 45, toolId, cycleId);
        await object(PUBLIC_BUCKET, 'logs/old/00-s1.log.gz', 777);
        const originalRemove = t.storage.remove.bind(t.storage);
        t.storage.remove = async (bucket, paths) => {
          // what Supabase does: removing an object removes its metadata row
          for (const p of paths)
            await t.handle.db.execute(
              sql`delete from storage.objects where bucket_id = ${bucket} and name = ${p}`,
            );
        };
        try {
          expect((await t.signed('/admin/gc', {})).json().freedBytes).toBe(777);
        } finally {
          t.storage.remove = originalRemove;
        }
      });
    });

    it('says null when the database cannot see Storage (an object it has no size for is never guessed)', async () => {
      const { toolId, cycleId } = await world();
      await runWithLog('old', 45, toolId, cycleId);
      const res = (await t.signed('/admin/gc', {})).json();
      expect(res.deletedLogs).toBe(1);
      expect(res.freedBytes).toBeNull();
    });
  });

  it('503 without Storage; and a storage failure leaves the database pointing at the files that still exist', async () => {
    const none = await startTestApp(dbUrl as string, { storage: null });
    expect((await none.signed('/admin/gc', {})).statusCode).toBe(503);
    await none.close();

    const { toolId, cycleId } = await world();
    await runWithLog('old', 45, toolId, cycleId);
    t.storage.remove = async () => {
      throw new Error('storage down');
    };
    expect((await t.signed('/admin/gc', {})).statusCode).toBe(502);
    expect(await logPaths()).toEqual(['logs/old/00-s1.log.gz']);
  });
});
