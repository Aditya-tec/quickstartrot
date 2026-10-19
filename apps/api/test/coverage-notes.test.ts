import { eq, sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { coverageNotes, COVERAGE_SENTENCES, Target } from '@qsr/core';
import { probeCycles, runs, tools } from '@qsr/db';
import { FIXED_NOW, resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// "What this check does not cover": the notes generated from a target's config (coverageNotes in @qsr/core) are stored with the tool when the
// targets are synced or a plan is pushed, and public_tools carries them, so the tool page can say what its check leaves out.

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

const db = () => t.handle.db;
const withKey = { placeholders: { YOUR_API_KEY: 'qsr_dummy_key' } };
const stored = async (slug: string): Promise<unknown> =>
  (await db().select({ n: tools.coverageNotes }).from(tools).where(eq(tools.slug, slug)))[0]?.n;
const sync = (specs: ReturnType<typeof targetInput>[]) =>
  t.signed('/internal/targets/sync', { targets: specs });

d('the notes of a tool', () => {
  it('are stored on sync, generated from the config', async () => {
    await sync([
      targetInput('keyed-node', withKey),
      targetInput('plain-node', { placeholders: {} }),
    ]);
    expect(await stored('keyed-node')).toEqual([COVERAGE_SENTENCES.placeholders]);
    expect(await stored('plain-node')).toEqual([]);
    expect(await stored('keyed-node')).toEqual(
      coverageNotes(Target.parse(targetInput('keyed-node', withKey))),
    );
  });

  it('are filled in for a tool synced before they existed, even though its config did not change', async () => {
    await sync([targetInput('keyed-node', withKey)]);
    await db().update(tools).set({ coverageNotes: [] }).where(eq(tools.slug, 'keyed-node'));
    const res = await sync([targetInput('keyed-node', withKey)]);
    expect(res.json().unchanged).toContain('keyed-node');
    expect(await stored('keyed-node')).toEqual([COVERAGE_SENTENCES.placeholders]);
  });

  it('follow the config when it changes', async () => {
    await sync([targetInput('keyed-node', withKey)]);
    await sync([targetInput('keyed-node', { placeholders: {} })]);
    expect(await stored('keyed-node')).toEqual([]);
  });

  it('are in public_tools, readable by the anon key', async () => {
    await sync([targetInput('keyed-node', withKey)]);
    const [c] = await db()
      .insert(probeCycles)
      .values({
        trigger: 'cron',
        gitSha: 'abcdef1',
        startedAt: new Date(FIXED_NOW.getTime() - 3600_000),
        finishedAt: new Date(FIXED_NOW.getTime() - 3000_000),
        valid: true,
        canaryOk: true,
      })
      .returning({ id: probeCycles.id });
    const toolId = (
      await db().select({ id: tools.id }).from(tools).where(eq(tools.slug, 'keyed-node'))
    )[0]?.id as string;
    await db()
      .insert(runs)
      .values({
        cycleId: (c as { id: string }).id,
        toolId,
        attempt: 1,
        outcome: 'PASS',
        reachedLevel: 2,
        imageDigest: 'sha256:abc',
        runnerEnv: {},
        durationMs: 1,
        startedAt: FIXED_NOW,
        finishedAt: FIXED_NOW,
      });
    const rows = await db().transaction(async (tx) => {
      await tx.execute(dsql`set local role anon`);
      return (await tx.execute(
        dsql`select coverage_notes from public_tools where slug = 'keyed-node'`,
      )) as unknown as { coverage_notes: string[] }[];
    });
    expect(rows[0]?.coverage_notes).toEqual([COVERAGE_SENTENCES.placeholders]);
  });
});
