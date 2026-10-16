import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { tools } from '@qsr/db';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// POST /internal/targets/sync (spec section 11): upsert all targets/*.yaml by slug; disable tools whose file
// was removed. An admin pause (vendor opt-out) must survive a re-sync.

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

const sync = (list: ReturnType<typeof targetInput>[]) =>
  t.signed('/internal/targets/sync', { targets: list });
const row = async (slug: string) =>
  (await t.handle.db.select().from(tools).where(eq(tools.slug, slug)))[0];

d('POST /internal/targets/sync', () => {
  it('creates a tool per target with its full config, a hash of it, and the target fields', async () => {
    const res = await sync([
      targetInput('chalk-node', { level: 3 }),
      targetInput('loguru-python', { language: 'python' }),
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      created: ['chalk-node', 'loguru-python'],
      updated: [],
      unchanged: [],
      disabled: [],
      keptDisabled: [],
    });
    const chalk = await row('chalk-node');
    expect(chalk).toMatchObject({
      slug: 'chalk-node',
      name: 'Tool chalk-node',
      docsUrl: 'https://docs.example.com/chalk-node',
      language: 'node',
      level: 3,
      enabled: true,
      disabledReason: null,
      status: 'UNKNOWN',
      isCanary: false,
    });
    expect(chalk?.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(chalk?.config).toMatchObject({
      slug: 'chalk-node',
      placeholders: { YOUR_API_KEY: 'qsr_dummy_key' },
    });
    expect((await row('loguru-python'))?.language).toBe('python');
  });

  it('marks canaries so the status engine and the public views leave them alone', async () => {
    await sync([targetInput('canary-pass-node'), targetInput('chalk-node')]);
    expect((await row('canary-pass-node'))?.isCanary).toBe(true);
    expect((await row('chalk-node'))?.isCanary).toBe(false);
  });

  it('syncing the same targets again changes nothing', async () => {
    await sync([targetInput('chalk-node')]);
    const before = await row('chalk-node');
    const res = await sync([targetInput('chalk-node')]);
    expect(res.json()).toMatchObject({ created: [], updated: [], unchanged: ['chalk-node'] });
    expect(await row('chalk-node')).toEqual(before);
  });

  it('updates a tool whose target file changed, keeping its status history', async () => {
    await sync([targetInput('chalk-node', { level: 2 })]);
    await t.handle.db
      .update(tools)
      .set({ status: 'HEALTHY', consecutivePasses: 5 })
      .where(eq(tools.slug, 'chalk-node'));
    const before = await row('chalk-node');
    const res = await sync([targetInput('chalk-node', { level: 3, name: 'Chalk' })]);
    expect(res.json()).toMatchObject({ updated: ['chalk-node'], unchanged: [] });
    const after = await row('chalk-node');
    expect(after).toMatchObject({
      level: 3,
      name: 'Chalk',
      status: 'HEALTHY',
      consecutivePasses: 5,
    });
    expect(after?.configHash).not.toBe(before?.configHash);
    expect(after?.id).toBe(before?.id);
  });

  it('disables a tool whose file was removed, and brings it back when the file returns', async () => {
    await sync([targetInput('chalk-node'), targetInput('zod-node')]);
    const gone = await sync([targetInput('chalk-node')]);
    expect(gone.json()).toMatchObject({ disabled: ['zod-node'], unchanged: ['chalk-node'] });
    expect(await row('zod-node')).toMatchObject({ enabled: false, disabledReason: 'file_removed' });
    const back = await sync([targetInput('chalk-node'), targetInput('zod-node')]);
    expect(back.json()).toMatchObject({ updated: ['zod-node'] });
    expect(await row('zod-node')).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('a tool paused by an admin (vendor opt-out) stays paused through every re-sync', async () => {
    await sync([targetInput('chalk-node')]);
    await t.handle.db
      .update(tools)
      .set({ enabled: false, disabledReason: 'admin' })
      .where(eq(tools.slug, 'chalk-node'));
    const res = await sync([targetInput('chalk-node')]);
    expect(res.json()).toMatchObject({ keptDisabled: ['chalk-node'], created: [], updated: [] });
    expect(await row('chalk-node')).toMatchObject({ enabled: false, disabledReason: 'admin' });
    // ... and removing then restoring the file does not undo the pause either
    await sync([]);
    await sync([targetInput('chalk-node')]);
    expect(await row('chalk-node')).toMatchObject({ enabled: false, disabledReason: 'admin' });
  });

  it('rejects an invalid target and duplicate slugs without writing anything', async () => {
    const bad = await sync([targetInput('ok-one'), { ...targetInput('Bad_Slug') }]);
    expect(bad.statusCode).toBe(400);
    const dup = await sync([targetInput('same-node'), targetInput('same-node')]);
    expect(dup.statusCode).toBe(400);
    expect(await t.handle.db.select().from(tools)).toHaveLength(0);
  });

  it('an empty list disables everything', async () => {
    await sync([targetInput('chalk-node')]);
    const res = await sync([]);
    expect(res.json()).toMatchObject({ disabled: ['chalk-node'] });
  });
});
