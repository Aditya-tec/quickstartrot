import { eq, sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { incidents, probeCycles, runs, tools } from '@qsr/db';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// A vendor opts out (the owner's decision of 2026-10-19): probing stops, the vendor's page stays up labelled as no longer monitored at the
// vendor's request, and past results stay visible and are hidden only if the vendor asks for that. The public views carry it, so the anon key
// cannot read what the site does not show.

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp(dbUrl as string, {
    config: {
      REVALIDATE_URL: 'https://web.example/api/revalidate',
      REVALIDATE_SECRET: 'revalidate-secret-0123456789',
    },
  });
});
afterAll(async () => {
  await t?.close();
});

const anon = async <T>(query: ReturnType<typeof dsql>): Promise<T[]> =>
  t.handle.db.transaction(async (tx) => {
    await tx.execute(dsql`set local role anon`);
    return (await tx.execute(query)) as unknown as T[];
  });
const idOf = async (slug: string): Promise<string> =>
  (
    (await t.handle.db.select({ id: tools.id }).from(tools).where(eq(tools.slug, slug)))[0] as {
      id: string;
    }
  ).id;
const toolRow = async (slug: string) =>
  (
    await t.handle.db.select().from(tools).where(eq(tools.slug, slug))
  )[0] as typeof tools.$inferSelect;

/** Two tools, each with a passing run in a valid cycle; acme-node also has a confirmed incident. */
beforeEach(async () => {
  await resetDb(t.handle);
  t.fetchCalls.length = 0;
  await t.signed('/internal/targets/sync', {
    targets: ['acme-node', 'bolt-node'].map((s) => targetInput(s, { level: 3 })),
  });
  const [cycle] = await t.handle.db
    .insert(probeCycles)
    .values({
      trigger: 'manual',
      gitSha: 'abcdef1',
      valid: true,
      canaryOk: true,
      startedAt: new Date(Date.now() - 3600_000),
      finishedAt: new Date(Date.now() - 3000_000),
    })
    .returning({ id: probeCycles.id });
  const cycleId = (cycle as { id: string }).id;
  for (const slug of ['acme-node', 'bolt-node']) {
    await t.handle.db.insert(runs).values({
      cycleId,
      toolId: await idOf(slug),
      attempt: 1,
      outcome: 'PASS',
      reachedLevel: 3,
      imageDigest: 'sha256:abc',
      runnerEnv: { node: 'v22.1.0' },
      durationMs: 4200,
      startedAt: new Date(Date.now() - 3500_000),
      finishedAt: new Date(Date.now() - 3400_000),
    });
  }
  await t.handle.db
    .update(tools)
    .set({
      status: 'HEALTHY',
      statusSince: new Date(Date.now() - 86_400_000),
      lastRunAt: new Date(Date.now() - 3500_000),
    })
    .where(eq(tools.slug, 'acme-node'));
  await t.handle.db.insert(incidents).values({
    toolId: await idOf('acme-node'),
    signature: 'sig-acme',
    failureClass: 'API_DRIFT',
    state: 'RESOLVED',
    review: 'CONFIRMED',
    summary: 'The vendor renamed a method.',
    suggestedFix: 'Use the new name.',
    confirmedAt: new Date(Date.now() - 7200_000),
    resolvedAt: new Date(Date.now() - 3600_000),
  });
});

const optOut = (slug: string, body?: unknown) =>
  t.admin('POST', `/admin/tools/${slug}/opt-out`, body);
const hide = (slug: string) => t.admin('POST', `/admin/tools/${slug}/hide-history`);
const publicTool = async (slug: string) =>
  (await anon<Record<string, unknown>>(dsql`select * from public_tools where slug = ${slug}`))[0];
const count = async (view: string, column: string, slug: string): Promise<number> =>
  (
    await anon<Record<string, unknown>>(
      dsql.raw(`select 1 from ${view} where ${column} = '${slug}'`),
    )
  ).length;

d('before an opt-out', () => {
  it('a tool has no opt-out date and its history is not hidden', async () => {
    const row = await publicTool('acme-node');
    expect(row).toMatchObject({ opted_out_at: null, history_hidden: false, last_outcome: 'PASS' });
  });
});

d('POST /admin/tools/:slug/opt-out', () => {
  it('stops probing: the tool is switched off with the reason opt_out, an opt-out date, and is not in the next cycle', async () => {
    const res = await optOut('acme-node');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: 'acme-node', historyHidden: false });
    expect(res.json().optedOutAt).toEqual(expect.any(String));
    const row = await toolRow('acme-node');
    expect(row).toMatchObject({ enabled: false, disabledReason: 'opt_out', historyHidden: false });
    expect(row.optedOutAt).toBeInstanceOf(Date);
    const cycle = await t.signed('/internal/cycles', {
      trigger: 'manual',
      gitSha: 'abcdef1234567',
      ghRunId: 5,
      ghRunAttempt: 1,
    });
    expect((cycle.json().tools as { slug: string }[]).map((x) => x.slug)).toEqual(['bolt-node']);
  });

  it('keeps the page and the past results public, with the date it stopped: the label comes from this', async () => {
    await optOut('acme-node');
    const row = await publicTool('acme-node');
    expect(row).toMatchObject({ slug: 'acme-node', history_hidden: false, last_outcome: 'PASS' });
    expect(row?.['opted_out_at']).not.toBeNull();
    expect(await count('public_run_history', 'tool_slug', 'acme-node')).toBe(1);
    expect(await count('public_runs', 'tool_slug', 'acme-node')).toBe(1);
    expect(await count('public_incidents', 'tool_slug', 'acme-node')).toBe(1);
    // the other tool is untouched
    expect((await publicTool('bolt-node'))?.['opted_out_at']).toBeNull();
  });

  it('with hideHistory the past results go: no runs, no history, no incidents, and the tool row carries no result', async () => {
    const res = await optOut('acme-node', { hideHistory: true });
    expect(res.json()).toMatchObject({ historyHidden: true });
    const row = await publicTool('acme-node');
    expect(row).toMatchObject({
      history_hidden: true,
      status: 'UNKNOWN',
      status_since: null,
      last_run_at: null,
      pass_rate_30d: null,
      last_run_id: null,
      last_outcome: null,
      last_reached_level: null,
      decided_30d: '0',
    });
    expect(row?.['opted_out_at']).not.toBeNull();
    expect(await count('public_run_history', 'tool_slug', 'acme-node')).toBe(0);
    expect(await count('public_runs', 'tool_slug', 'acme-node')).toBe(0);
    expect(await count('public_incidents', 'tool_slug', 'acme-node')).toBe(0);
    expect(await count('public_run_history', 'tool_slug', 'bolt-node')).toBe(1);
  });

  it('is idempotent: the first date stands, and a second opt-out without hideHistory does not bring a hidden history back', async () => {
    await optOut('acme-node', { hideHistory: true });
    const first = (await toolRow('acme-node')).optedOutAt;
    const again = await optOut('acme-node');
    expect(again.statusCode).toBe(200);
    const row = await toolRow('acme-node');
    expect(row.optedOutAt?.getTime()).toBe(first?.getTime());
    expect(row.historyHidden).toBe(true);
  });

  it('tells the site, 404s an unknown tool, and needs the admin token', async () => {
    await optOut('acme-node');
    expect(t.fetchCalls.map((c) => c.url)).toContain('https://web.example/api/revalidate');
    expect((await optOut('no-such-node')).statusCode).toBe(404);
    expect(
      (await t.app.inject({ method: 'POST', url: '/admin/tools/acme-node/opt-out' })).statusCode,
    ).toBe(401);
    expect((await optOut('acme-node', { hideHistory: 'yes' })).statusCode).toBe(400);
  });

  it('a sync that still lists the target as enabled does not switch it back on', async () => {
    await optOut('acme-node');
    const sync = await t.signed('/internal/targets/sync', {
      targets: ['acme-node', 'bolt-node'].map((s) => targetInput(s, { level: 3 })),
    });
    expect(sync.json().keptDisabled).toContain('acme-node');
    expect(await toolRow('acme-node')).toMatchObject({ enabled: false, disabledReason: 'opt_out' });
    // even when the file changes
    const changed = await t.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 2 }), targetInput('bolt-node', { level: 3 })],
    });
    expect(changed.json().keptDisabled).toContain('acme-node');
    expect((await toolRow('acme-node')).enabled).toBe(false);
  });
});

d('POST /admin/tools/:slug/hide-history', () => {
  it('hides the past results of a tool that opted out, when the vendor asks for it later', async () => {
    await optOut('acme-node');
    expect(await count('public_runs', 'tool_slug', 'acme-node')).toBe(1);
    const res = await hide('acme-node');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: 'acme-node', historyHidden: true });
    expect(await count('public_runs', 'tool_slug', 'acme-node')).toBe(0);
    expect((await publicTool('acme-node'))?.['history_hidden']).toBe(true);
  });

  it('is a 409 for a tool that has not opted out: history is hidden on request only, and only after an opt-out', async () => {
    const res = await hide('bolt-node');
    expect(res.statusCode).toBe(409);
    expect(await count('public_runs', 'tool_slug', 'bolt-node')).toBe(1);
    expect((await hide('no-such-node')).statusCode).toBe(404);
  });
});

d('an admin pause is not an opt-out', () => {
  it('POST /admin/tools/:slug/disable still takes the tool off the public views entirely, with no label', async () => {
    await t.admin('POST', '/admin/tools/acme-node/disable');
    expect(await publicTool('acme-node')).toBeUndefined();
    expect(await count('public_runs', 'tool_slug', 'acme-node')).toBe(0);
    expect((await toolRow('acme-node')).optedOutAt).toBeNull();
  });
});
