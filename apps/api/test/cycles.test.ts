import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { probeCycles, tools } from '@qsr/db';
import { eq } from 'drizzle-orm';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// POST /internal/cycles (spec section 11): create a probe cycle, return its id and the enabled tool list.
// Idempotent on (gh_run_id, run attempt): a retried plan job must not create a second cycle.

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

const sync = (...slugs: string[]) =>
  t.signed('/internal/targets/sync', { targets: slugs.map((s) => targetInput(s)) });
const create = (body: Record<string, unknown> = {}) =>
  t.signed('/internal/cycles', {
    trigger: 'cron',
    gitSha: 'abcdef1234567',
    ghRunId: 9001,
    ghRunAttempt: 1,
    ...body,
  });
const cycles = () => t.handle.db.select().from(probeCycles);

d('POST /internal/cycles', () => {
  it('creates a cycle and returns its id with the enabled tools, canaries flagged, in slug order', async () => {
    await sync('zod-node', 'chalk-node', 'canary-pass-node');
    const res = await create();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ cycleId: expect.any(String), created: true });
    expect(body.tools.map((x: { slug: string }) => x.slug)).toEqual([
      'canary-pass-node',
      'chalk-node',
      'zod-node',
    ]);
    expect(body.tools[0]).toEqual({
      slug: 'canary-pass-node',
      name: 'Tool canary-pass-node',
      docsUrl: 'https://docs.example.com/canary-pass-node',
      language: 'node',
      level: 2,
      isCanary: true,
      lastDurationMs: null,
    });
    expect(body.tools[1].isCanary).toBe(false);
    const [row] = await cycles();
    expect(row).toMatchObject({
      id: body.cycleId,
      trigger: 'cron',
      gitSha: 'abcdef1234567',
      ghRunId: 9001,
      ghRunAttempt: 1,
      valid: null,
      canaryOk: null,
      finishedAt: null,
    });
    expect(row?.startedAt.toISOString()).toBe('2026-10-16T12:00:00.000Z');
  });

  it('leaves out disabled tools', async () => {
    await sync('chalk-node', 'zod-node');
    await t.handle.db
      .update(tools)
      .set({ enabled: false, disabledReason: 'admin' })
      .where(eq(tools.slug, 'zod-node'));
    const res = await create();
    expect(res.json().tools.map((x: { slug: string }) => x.slug)).toEqual(['chalk-node']);
  });

  it('is idempotent on (gh_run_id, attempt): a retried plan job gets the same cycle', async () => {
    await sync('chalk-node');
    const first = await create();
    const again = await create();
    expect(again.json()).toMatchObject({ cycleId: first.json().cycleId, created: false });
    expect(await cycles()).toHaveLength(1);
  });

  it('a re-run of the same workflow run (attempt 2), or a different run, is a new cycle', async () => {
    await sync('chalk-node');
    const a = await create();
    const b = await create({ ghRunAttempt: 2 });
    const c = await create({ ghRunId: 9002 });
    expect(new Set([a, b, c].map((r) => r.json().cycleId)).size).toBe(3);
    expect([b, c].map((r) => r.json().created)).toEqual([true, true]);
  });

  it('without a gh_run_id (a manual local cycle) every call is a new cycle', async () => {
    await sync('chalk-node');
    const a = await create({ trigger: 'manual', ghRunId: undefined });
    const b = await create({ trigger: 'manual', ghRunId: undefined });
    expect(a.json().cycleId).not.toBe(b.json().cycleId);
    expect(await cycles()).toHaveLength(2);
  });

  it('five simultaneous identical requests still make exactly one cycle', async () => {
    await sync('chalk-node');
    const results = await Promise.all(Array.from({ length: 5 }, () => create()));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json().cycleId)).size).toBe(1);
    expect(results.filter((r) => r.json().created)).toHaveLength(1);
    expect(await cycles()).toHaveLength(1);
  });

  it('rejects a bad trigger, a short sha and a non-positive run id', async () => {
    expect((await create({ trigger: 'whenever' })).statusCode).toBe(400);
    expect((await create({ gitSha: 'abc' })).statusCode).toBe(400);
    expect((await create({ ghRunId: 0 })).statusCode).toBe(400);
    expect((await create({ ghRunAttempt: 0 })).statusCode).toBe(400);
  });

  it('works with no tools yet (an empty list, not an error)', async () => {
    const res = await create();
    expect(res.statusCode).toBe(200);
    expect(res.json().tools).toEqual([]);
  });
});
