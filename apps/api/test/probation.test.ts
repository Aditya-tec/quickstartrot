import { eq, sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PROBATION } from '@qsr/core';
import { incidents, probeCycles, runs, tools } from '@qsr/db';
import { FIXED_NOW, resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// A new target is on probation (target file: `probation`). It is enabled and probed every cycle, but until it has two valid cycles it is in
// no public number: not in the public views (so not in the site, the headline, the badge or /api/status), not in the launch export and not
// in the harness error rate. The views release it by themselves at the second valid cycle; the file's flag is removed afterwards.

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp(dbUrl as string);
});
afterAll(async () => {
  await t?.close();
});

const HOUR = 3600_000;
const ago = (ms: number) => new Date(FIXED_NOW.getTime() - ms);
const db = () => t.handle.db;
const probation = { reason: 'New target: public after two valid cycles.' };

const anon = async <T>(query: ReturnType<typeof dsql>): Promise<T[]> =>
  db().transaction(async (tx) => {
    await tx.execute(dsql`set local role anon`);
    return (await tx.execute(query)) as unknown as T[];
  });
const idOf = async (slug: string): Promise<string> =>
  (
    (await db().select({ id: tools.id }).from(tools).where(eq(tools.slug, slug)))[0] as {
      id: string;
    }
  ).id;
const syncTargets = (specs: { slug: string; probation?: boolean }[]) =>
  t.signed('/internal/targets/sync', {
    targets: specs.map((s) =>
      targetInput(s.slug, { level: 2, ...(s.probation ? { probation } : {}) }),
    ),
  });

let cycleSeq = 0;
/** A finished cycle (valid by default) with one final run of each named tool. */
async function cycle(slugs: string[], valid = true, attempts = 1): Promise<string> {
  cycleSeq += 1;
  const [c] = await db()
    .insert(probeCycles)
    .values({
      trigger: 'cron',
      gitSha: 'abcdef1',
      startedAt: ago((40 - cycleSeq) * HOUR),
      finishedAt: ago((40 - cycleSeq) * HOUR - 20 * 60_000),
      valid,
      canaryOk: valid,
    })
    .returning({ id: probeCycles.id });
  const cycleId = (c as { id: string }).id;
  for (const slug of slugs)
    for (let attempt = 1; attempt <= attempts; attempt += 1)
      await db()
        .insert(runs)
        .values({
          cycleId,
          toolId: await idOf(slug),
          attempt,
          outcome: 'PASS',
          reachedLevel: 2,
          imageDigest: 'sha256:abc',
          runnerEnv: {},
          durationMs: 1000,
          startedAt: ago((40 - cycleSeq) * HOUR - 60_000),
          finishedAt: ago((40 - cycleSeq) * HOUR - 30_000),
        });
  return cycleId;
}

const inView = async (view: string, column: string, slug: string): Promise<number> =>
  (await anon(dsql.raw(`select 1 from ${view} where ${column} = '${slug}'`))).length;
const visibleEverywhere = async (slug: string): Promise<boolean[]> => [
  (await inView('public_tools', 'slug', slug)) > 0,
  (await inView('public_run_history', 'tool_slug', slug)) > 0,
  (await inView('public_runs', 'tool_slug', slug)) > 0,
];

beforeEach(async () => {
  await resetDb(t.handle);
  cycleSeq = 0;
  await syncTargets([{ slug: 'old-node' }, { slug: 'new-node', probation: true }]);
});

d('the constant', () => {
  it('is two valid cycles, and the migration says the same number', async () => {
    expect(PROBATION.validCycles).toBe(2);
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../../../packages/db/drizzle/', import.meta.url);
    const file = readdirSync(dir).find((f) => f.endsWith('_probation.sql')) as string;
    expect(readFileSync(new URL(file, dir), 'utf8')).toContain(`>= ${PROBATION.validCycles}`);
  });
});

d('target sync', () => {
  it('stores the flag of the target file, and clears it when the file drops it', async () => {
    const flag = async (slug: string) =>
      (await db().select({ p: tools.probation }).from(tools).where(eq(tools.slug, slug)))[0]?.p;
    expect(await flag('new-node')).toBe(true);
    expect(await flag('old-node')).toBe(false);
    await syncTargets([{ slug: 'old-node' }, { slug: 'new-node' }]);
    expect(await flag('new-node')).toBe(false);
  });
});

d('the public views', () => {
  it('hide a target on probation until it has two valid cycles, and release it at the second', async () => {
    await cycle(['old-node', 'new-node']);
    expect(await visibleEverywhere('old-node')).toEqual([true, true, true]);
    expect(await visibleEverywhere('new-node')).toEqual([false, false, false]);
    await cycle(['old-node', 'new-node']);
    expect(await visibleEverywhere('new-node')).toEqual([true, true, true]);
  });

  it('a target on probation with no run at all is not listed as "not yet tested" either', async () => {
    expect(await inView('public_tools', 'slug', 'new-node')).toBe(0);
    // while a tool without the flag, with no run, is listed as before
    expect(await inView('public_tools', 'slug', 'old-node')).toBe(1);
  });

  it('cycles that are not valid do not count', async () => {
    await cycle(['new-node'], true);
    await cycle(['new-node'], false);
    await cycle(['new-node'], false);
    expect(await inView('public_tools', 'slug', 'new-node')).toBe(0);
  });

  it('two attempts in one cycle are one cycle', async () => {
    await cycle(['new-node'], true, 2);
    expect(await inView('public_tools', 'slug', 'new-node')).toBe(0);
  });

  it('hide its confirmed incident too', async () => {
    await cycle(['new-node']);
    await db()
      .insert(incidents)
      .values({
        toolId: await idOf('new-node'),
        signature: 'sig-new',
        failureClass: 'API_DRIFT',
        state: 'OPEN',
        review: 'CONFIRMED',
        summary: 'x',
        suggestedFix: 'y',
        confirmedAt: ago(HOUR),
      });
    expect(await inView('public_incidents', 'tool_slug', 'new-node')).toBe(0);
    await cycle(['new-node']);
    expect(await inView('public_incidents', 'tool_slug', 'new-node')).toBe(1);
  });

  it('do not touch a target that is not on probation, however few cycles it has', async () => {
    await cycle(['old-node']);
    expect(await visibleEverywhere('old-node')).toEqual([true, true, true]);
  });
});

d('the numbers a post could quote', () => {
  it('the launch export leaves a target on probation out: tracked, level counts, runs, cycles per tool', async () => {
    await cycle(['old-node', 'new-node']);
    const before = (await t.admin('GET', '/admin/export/launch')).json();
    expect(before.tools.tracked).toBe(1);
    expect(before.runs.total).toBe(1);
    expect(before.runs.perTool.map((x: { slug: string }) => x.slug)).toEqual(['old-node']);
    await cycle(['old-node', 'new-node']);
    const after = (await t.admin('GET', '/admin/export/launch')).json();
    expect(after.tools.tracked).toBe(2);
    expect(after.runs.perTool.map((x: { slug: string }) => x.slug)).toEqual([
      'new-node',
      'old-node',
    ]);
  });

  it('the harness error rate does not count its runs, while the per-tool table still shows them for the operator', async () => {
    const c = await cycle(['old-node', 'new-node']);
    await db()
      .update(runs)
      .set({ outcome: 'HARNESS_ERROR' })
      .where(eq(runs.toolId, await idOf('new-node')));
    void c;
    const stats = (await t.admin('GET', '/admin/stats?days=7')).json();
    expect(stats.harness.overall).toMatchObject({ runs: 1, errors: 0 });
    const row = stats.tools.find((x: { slug: string }) => x.slug === 'new-node');
    expect(row).toMatchObject({ harnessErrors: 1 });
  });
});

d('the helper tables stay private', () => {
  it('the anon key cannot read the tools table directly', async () => {
    await expect(anon(dsql`select probation from tools limit 1`)).rejects.toThrow();
  });
});
