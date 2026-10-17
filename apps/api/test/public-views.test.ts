import { eq } from 'drizzle-orm';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  compiledPlans,
  docSnapshots,
  incidents,
  probeCycles,
  runs,
  stepResults,
  tools,
} from '@qsr/db';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';

// Migration 0006: the public views the web app reads (spec sections 5 and 13). The rule behind all of it:
// an unreviewed failure shows "verifying" and NO cause text, in the database as well as on the site. The anon
// role (anyone with the public key) must never be able to read a cause that a person has not confirmed.

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
  await t.signed('/internal/targets/sync', {
    targets: ['acme-node', 'bolt-node', 'canary-pass-node'].map((s) =>
      targetInput(s, { level: 3 }),
    ),
  });
});

const DAY = 24 * 3600 * 1000;
const T0 = Date.now() - 20 * DAY;
const at = (hours: number): Date => new Date(T0 + hours * 3600 * 1000);
/** Text that must never reach an anonymous reader unless a person confirmed the incident it belongs to. */
const CAUSE = 'ZZCAUSE-7f3a: acme.send is not a function (the vendor renamed it)';
const CAUSE_SIG = 'ZZSIG-91bc44aa';

const anon = async <T>(query: ReturnType<typeof dsql>): Promise<T[]> =>
  t.handle.db.transaction(async (tx) => {
    await tx.execute(dsql`set local role anon`);
    return (await tx.execute(query)) as unknown as T[];
  });

async function toolIdOf(slug: string): Promise<string> {
  const [row] = await t.handle.db.select({ id: tools.id }).from(tools).where(eq(tools.slug, slug));
  return (row as { id: string }).id;
}
async function addCycle(valid: boolean, startedAt: Date): Promise<string> {
  const [row] = await t.handle.db
    .insert(probeCycles)
    .values({
      trigger: 'manual',
      gitSha: 'abcdef1',
      valid,
      canaryOk: valid,
      startedAt,
      finishedAt: startedAt,
    })
    .returning({ id: probeCycles.id });
  return (row as { id: string }).id;
}

interface StepSpec {
  stepId: string;
  ordinal: number;
  kind?: string;
  outcome?: string;
  stderrTail?: string | null;
  logPath?: string | null;
}
interface RunSpec {
  slug: string;
  cycleId: string;
  startedAt: Date;
  attempt?: number;
  outcome?: 'PASS' | 'FAIL' | 'HARNESS_ERROR' | 'SKIPPED';
  failureClass?: (typeof runs.$inferInsert)['failureClass'];
  signature?: string | null;
  reached?: number;
  skipReason?: string | null;
  env?: Record<string, string>;
  steps?: StepSpec[];
  planId?: string | null;
  snapshotId?: string | null;
}
async function addRun(o: RunSpec): Promise<string> {
  const [row] = await t.handle.db
    .insert(runs)
    .values({
      cycleId: o.cycleId,
      toolId: await toolIdOf(o.slug),
      attempt: o.attempt ?? 1,
      outcome: o.outcome ?? 'PASS',
      failureClass: o.failureClass ?? null,
      failureSignature: o.signature ?? null,
      failedStepId:
        o.outcome === 'FAIL' && o.steps?.length ? (o.steps.at(-1)?.stepId ?? null) : null,
      reachedLevel: o.reached ?? 3,
      skipReason: o.skipReason ?? null,
      imageDigest: 'sha256:abc',
      runnerEnv: o.env ?? { node: 'v22.1.0' },
      durationMs: 4200,
      startedAt: o.startedAt,
      finishedAt: new Date(o.startedAt.getTime() + 4200),
      planId: o.planId ?? null,
      snapshotId: o.snapshotId ?? null,
    })
    .returning({ id: runs.id });
  const id = (row as { id: string }).id;
  if (o.steps?.length)
    await t.handle.db.insert(stepResults).values(
      o.steps.map((s) => ({
        runId: id,
        stepId: s.stepId,
        ordinal: s.ordinal,
        kind: s.kind ?? 'shell',
        outcome: s.outcome ?? 'PASS',
        exitCode: s.outcome === 'FAIL' ? 1 : 0,
        durationMs: 100,
        stdoutTail: s.stderrTail ? 'some output' : null,
        stderrTail: s.stderrTail ?? null,
        logPath: s.logPath ?? null,
      })),
    );
  return id;
}
const failingRun = (slug: string, cycleId: string, startedAt: Date, over: Partial<RunSpec> = {}) =>
  addRun({
    slug,
    cycleId,
    startedAt,
    outcome: 'FAIL',
    failureClass: 'API_DRIFT',
    signature: CAUSE_SIG,
    reached: 2,
    steps: [
      { stepId: 's1', ordinal: 0 },
      {
        stepId: 's2',
        ordinal: 1,
        kind: 'run',
        outcome: 'FAIL',
        stderrTail: CAUSE,
        logPath: 'logs/x/01-s2.log.gz',
      },
    ],
    ...over,
  });

async function incident(
  slug: string,
  over: Partial<typeof incidents.$inferInsert> & { firstFailing: string },
): Promise<string> {
  const { firstFailing, ...rest } = over;
  const [row] = await t.handle.db
    .insert(incidents)
    .values({
      toolId: await toolIdOf(slug),
      signature: CAUSE_SIG,
      failureClass: 'API_DRIFT',
      firstFailingRunId: firstFailing,
      openedAt: at(10),
      ...rest,
    })
    .returning({ id: incidents.id });
  return (row as { id: string }).id;
}

type Row = Record<string, unknown>;
const text = (rows: unknown): string => JSON.stringify(rows);

d('public_run_history: one lightweight row per cycle and tool, newest first', () => {
  it('has only the final attempt of each cycle, only valid cycles, and never a canary', async () => {
    const c1 = await addCycle(true, at(1));
    await failingRun('acme-node', c1, at(1), { attempt: 1, failureClass: 'NETWORK_TRANSIENT' });
    await addRun({ slug: 'acme-node', cycleId: c1, startedAt: at(1.1), attempt: 2 });
    const invalid = await addCycle(false, at(2));
    await addRun({ slug: 'acme-node', cycleId: invalid, startedAt: at(2) });
    await addRun({ slug: 'canary-pass-node', cycleId: c1, startedAt: at(1) });

    const rows = await anon<Row>(dsql`select * from public_run_history order by started_at`);
    expect(rows.map((r) => [r['tool_slug'], r['kind']])).toEqual([['acme-node', 'pass']]);
  });

  it('classifies each run without saying why: pass, fail, not_run, harness, skipped, with the stale flag', async () => {
    const c = async (h: number) => addCycle(true, at(h));
    await addRun({ slug: 'acme-node', cycleId: await c(1), startedAt: at(1) });
    await failingRun('acme-node', await c(2), at(2));
    await failingRun('acme-node', await c(3), at(3), {
      failureClass: 'CRAWL_ERROR',
      signature: 'CRAWL_ERROR:no_code_blocks',
      reached: 0,
      steps: [],
    });
    await addRun({
      slug: 'acme-node',
      cycleId: await c(4),
      startedAt: at(4),
      outcome: 'HARNESS_ERROR',
      failureClass: 'HARNESS_ERROR',
      reached: 0,
    });
    await addRun({
      slug: 'acme-node',
      cycleId: await c(5),
      startedAt: at(5),
      outcome: 'SKIPPED',
      reached: 0,
      skipReason: 'manual_step',
    });
    await addRun({
      slug: 'acme-node',
      cycleId: await c(6),
      startedAt: at(6),
      env: { plan_stale: 'true' },
    });

    const rows = await anon<Row>(
      dsql`select kind, stale, rn from public_run_history where tool_slug = 'acme-node' order by started_at`,
    );
    expect(rows.map((r) => r['kind'])).toEqual([
      'pass',
      'fail',
      'not_run',
      'harness',
      'skipped',
      'pass',
    ]);
    expect(rows.map((r) => r['stale'])).toEqual([false, false, false, false, false, true]);
    expect(rows.map((r) => Number(r['rn']))).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('has no column that could carry a cause', async () => {
    await failingRun('acme-node', await addCycle(true, at(1)), at(1));
    const [row] = await anon<Row>(dsql`select * from public_run_history`);
    expect(Object.keys(row as Row).sort()).toEqual(
      [
        'duration_ms',
        'kind',
        'outcome',
        'reached_level',
        'rn',
        'run_id',
        'stale',
        'started_at',
        'target_level',
        'tool_slug',
      ].sort(),
    );
    expect(text(row)).not.toContain('ZZ');
  });

  it('keeps the newest 60 per tool', async () => {
    for (let i = 0; i < 65; i += 1)
      await addRun({ slug: 'acme-node', cycleId: await addCycle(true, at(i)), startedAt: at(i) });
    await addRun({ slug: 'bolt-node', cycleId: await addCycle(true, at(1)), startedAt: at(1) });
    const rows = await anon<Row>(dsql`select tool_slug, rn from public_run_history`);
    const acme = rows.filter((r) => r['tool_slug'] === 'acme-node').map((r) => Number(r['rn']));
    expect(acme).toHaveLength(60);
    expect(Math.min(...acme)).toBe(1);
    expect(Math.max(...acme)).toBe(60);
    expect(rows.filter((r) => r['tool_slug'] === 'bolt-node')).toHaveLength(1);
  });

  it('hides a disabled tool (an opt-out hides its history)', async () => {
    await addRun({ slug: 'acme-node', cycleId: await addCycle(true, at(1)), startedAt: at(1) });
    await t.handle.db.update(tools).set({ enabled: false }).where(eq(tools.slug, 'acme-node'));
    expect(await anon(dsql`select * from public_run_history`)).toEqual([]);
  });
});

d('public_runs: the cause of an unreviewed failure is not readable', () => {
  const view = async (id: string) =>
    (await anon<Row>(dsql`select * from public_runs where id = ${id}`))[0] as Row;
  type StepJson = {
    stderr_tail: string | null;
    stdout_tail: string | null;
    log_path: string | null;
    outcome: string;
    exit_code: number | null;
  };

  it('a failing run with no confirmed incident shows its outcome and nothing about why', async () => {
    const id = await failingRun('acme-node', await addCycle(true, at(1)), at(1));
    const row = await view(id);
    expect(row['outcome']).toBe('FAIL');
    expect(row['details_published']).toBe(false);
    expect(row['failure_class']).toBeNull();
    expect(row['failure_signature']).toBeNull();
    expect(row['failed_step_id']).toBeNull();
    const steps = row['steps'] as StepJson[];
    expect(steps).toHaveLength(2);
    expect(
      steps.every((s) => s.stderr_tail === null && s.stdout_tail === null && s.log_path === null),
    ).toBe(true);
    expect(text(row)).not.toContain('ZZ');
  });

  it('...also when its incident is only PENDING_REVIEW or was marked a FALSE_POSITIVE', async () => {
    const first = await failingRun('acme-node', await addCycle(true, at(1)), at(1));
    await incident('acme-node', { firstFailing: first, review: 'PENDING_REVIEW', summary: CAUSE });
    expect(text(await view(first))).not.toContain('ZZ');

    const other = await failingRun('bolt-node', await addCycle(true, at(2)), at(2));
    await incident('bolt-node', {
      firstFailing: other,
      review: 'FALSE_POSITIVE',
      state: 'RESOLVED',
      resolvedAt: at(5),
      summary: CAUSE,
    });
    expect(text(await view(other))).not.toContain('ZZ');
  });

  it('a run inside a CONFIRMED incident publishes its class, signature, failed step, tails and log path', async () => {
    const first = await failingRun('acme-node', await addCycle(true, at(1)), at(1));
    const later = await failingRun('acme-node', await addCycle(true, at(3)), at(3));
    await incident('acme-node', {
      firstFailing: first,
      review: 'CONFIRMED',
      confirmedAt: at(4),
      summary: 'Renamed.',
    });
    for (const id of [first, later]) {
      const row = await view(id);
      expect(row['details_published']).toBe(true);
      expect(row['failure_class']).toBe('API_DRIFT');
      expect(row['failure_signature']).toBe(CAUSE_SIG);
      expect(row['failed_step_id']).toBe('s2');
      const failed = (row['steps'] as StepJson[]).find((s) => s.outcome === 'FAIL');
      expect(failed?.stderr_tail).toBe(CAUSE);
      expect(failed?.log_path).toBe('logs/x/01-s2.log.gz');
    }
  });

  it('a failure BEFORE the incident, or AFTER it was resolved, is a different failure: still masked', async () => {
    const before = await failingRun('acme-node', await addCycle(true, at(0.5)), at(0.5));
    const first = await failingRun('acme-node', await addCycle(true, at(1)), at(1));
    await incident('acme-node', {
      firstFailing: first,
      review: 'CONFIRMED',
      confirmedAt: at(2),
      state: 'RESOLVED',
      resolvedAt: at(4),
    });
    const after = await failingRun('acme-node', await addCycle(true, at(9)), at(9));
    expect((await view(first))['details_published']).toBe(true);
    for (const id of [before, after]) {
      const row = await view(id);
      expect(row['details_published']).toBe(false);
      expect(text(row)).not.toContain('ZZ');
    }
  });

  it('a confirmed incident of one tool publishes nothing of another', async () => {
    const mine = await failingRun('acme-node', await addCycle(true, at(1)), at(1));
    await incident('acme-node', { firstFailing: mine, review: 'CONFIRMED', confirmedAt: at(2) });
    const theirs = await failingRun('bolt-node', await addCycle(true, at(1)), at(1));
    expect((await view(theirs))['details_published']).toBe(false);
  });

  it('runs that are about us, not the vendor, keep their class: pre-flight and harness errors', async () => {
    const c1 = await addCycle(true, at(1));
    const pre = await failingRun('acme-node', c1, at(1), {
      failureClass: 'CRAWL_ERROR',
      signature: 'CRAWL_ERROR:no_code_blocks',
      reached: 0,
      steps: [],
    });
    const c2 = await addCycle(true, at(2));
    const harness = await addRun({
      slug: 'acme-node',
      cycleId: c2,
      startedAt: at(2),
      outcome: 'HARNESS_ERROR',
      failureClass: 'HARNESS_ERROR',
      reached: 0,
    });
    expect((await view(pre))['failure_class']).toBe('CRAWL_ERROR');
    expect((await view(pre))['details_published']).toBe(true);
    expect((await view(harness))['failure_class']).toBe('HARNESS_ERROR');
  });

  it('a passing run is untouched and shows its steps', async () => {
    const id = await addRun({
      slug: 'acme-node',
      cycleId: await addCycle(true, at(1)),
      startedAt: at(1),
      steps: [{ stepId: 's1', ordinal: 0, stderrTail: 'npm warn something' }],
    });
    const row = await view(id);
    expect(row['details_published']).toBe(true);
    expect((row['steps'] as StepJson[])[0]?.stderr_tail).toBe('npm warn something');
  });

  it('adds the plan and the docs the run was built from', async () => {
    const toolId = await toolIdOf('acme-node');
    const [snap] = await t.handle.db
      .insert(docSnapshots)
      .values({
        toolId,
        contentHash: 'h'.repeat(64),
        extraction: {
          url: 'https://docs.example.com/a',
          title: 'Acme',
          blocks: [
            {
              index: 0,
              kind: 'code',
              lang: 'bash',
              text: 'npm i acme',
              filenameHint: null,
              headingPath: [],
            },
          ],
        },
      })
      .returning({ id: docSnapshots.id });
    const [plan] = await t.handle.db
      .insert(compiledPlans)
      .values({
        toolId,
        contentHash: 'h'.repeat(64),
        configHash: 'c'.repeat(64),
        compilerVersion: '2026-10-16.5',
        model: 'm',
        ir: { steps: [] },
        groundingReport: { ok: true, violations: [] },
        accepted: true,
        truncation: {
          truncated: true,
          totalBlocks: 9,
          includedBlocks: 5,
          omittedBlocks: 4,
          omittedBlockIndexes: [5, 6, 7, 8],
          clippedBlockIndexes: [],
        },
      })
      .returning({ id: compiledPlans.id });
    const id = await addRun({
      slug: 'acme-node',
      cycleId: await addCycle(true, at(1)),
      startedAt: at(1),
      planId: (plan as { id: string }).id,
      snapshotId: (snap as { id: string }).id,
      env: { plan_stale: 'true' },
    });
    const row = await view(id);
    expect(row['plan_compiler_version']).toBe('2026-10-16.5');
    expect(row['plan_truncation']).toMatchObject({ truncated: true, omittedBlocks: 4 });
    expect(row['plan_stale']).toBe(true);
    expect((row['snapshot_blocks'] as { text: string }[])[0]?.text).toBe('npm i acme');
    expect(row['snapshot_title']).toBe('Acme');
  });

  it('still hides canaries, disabled tools and invalid cycles', async () => {
    await addRun({
      slug: 'canary-pass-node',
      cycleId: await addCycle(true, at(1)),
      startedAt: at(1),
    });
    await addRun({ slug: 'acme-node', cycleId: await addCycle(false, at(2)), startedAt: at(2) });
    expect(await anon(dsql`select id from public_runs`)).toEqual([]);
  });
});

d('public_incidents: only what a person confirmed', () => {
  it('lists CONFIRMED incidents only, with the version diff, and no pending or false-positive text', async () => {
    const a = await failingRun('acme-node', await addCycle(true, at(1)), at(1));
    await incident('acme-node', {
      firstFailing: a,
      review: 'CONFIRMED',
      signature: 'CONFIRMED-SIG-1',
      confirmedAt: at(2),
      summary: 'The send method was renamed.',
      suggestedFix: 'Use deliver().',
      docsChanged: true,
      docsDiffPath: 'diffs/acme.diff',
      versionDiff: {
        changed: [{ name: 'acme', from: '3.4.1', to: '4.0.0' }],
        added: [],
        removed: [],
      },
    });
    const b = await failingRun('bolt-node', await addCycle(true, at(1)), at(1));
    await incident('bolt-node', {
      firstFailing: b,
      review: 'PENDING_REVIEW',
      summary: CAUSE,
      suggestedFix: CAUSE,
    });
    const c = await failingRun('bolt-node', await addCycle(true, at(3)), at(3));
    await incident('bolt-node', {
      firstFailing: c,
      review: 'FALSE_POSITIVE',
      state: 'RESOLVED',
      resolvedAt: at(5),
      summary: CAUSE,
    });

    const rows = await anon<Row>(dsql`select * from public_incidents`);
    expect(rows.map((r) => r['tool_slug'])).toEqual(['acme-node']);
    expect(rows[0]).toMatchObject({
      review: 'CONFIRMED',
      summary: 'The send method was renamed.',
      docs_changed: true,
      docs_diff_path: 'diffs/acme.diff',
      version_diff: { changed: [{ name: 'acme', from: '3.4.1', to: '4.0.0' }] },
    });
    expect(text(rows)).not.toContain('ZZ');
  });

  it('never lists the incident of a canary', async () => {
    const a = await failingRun('canary-pass-node', await addCycle(true, at(1)), at(1));
    await incident('canary-pass-node', {
      firstFailing: a,
      review: 'CONFIRMED',
      confirmedAt: at(2),
    });
    expect(await anon(dsql`select * from public_incidents`)).toEqual([]);
  });
});

d('public_tools: what the home page needs about the latest run', () => {
  it('carries the latest final run (id, outcome, level reached, skip reason) and the count behind the pass rate', async () => {
    const c1 = await addCycle(true, at(1));
    await addRun({ slug: 'acme-node', cycleId: c1, startedAt: at(1) });
    const c2 = await addCycle(true, at(2));
    const latest = await addRun({ slug: 'acme-node', cycleId: c2, startedAt: at(2), reached: 2 });
    await addRun({
      slug: 'bolt-node',
      cycleId: await addCycle(true, at(3)),
      startedAt: at(3),
      outcome: 'SKIPPED',
      reached: 0,
      skipReason: 'manual_step',
    });

    const rows = await anon<Row>(
      dsql`select slug, last_run_id, last_outcome, last_reached_level, last_skip_reason, decided_30d from public_tools order by slug`,
    );
    const acme = rows.find((r) => r['slug'] === 'acme-node') as Row;
    expect(acme).toMatchObject({
      last_run_id: latest,
      last_outcome: 'PASS',
      last_reached_level: 2,
    });
    expect(Number(acme['decided_30d'])).toBe(2);
    const bolt = rows.find((r) => r['slug'] === 'bolt-node') as Row;
    expect(bolt).toMatchObject({ last_outcome: 'SKIPPED', last_skip_reason: 'manual_step' });
    expect(Number(bolt['decided_30d'])).toBe(0);
  });

  it('a tool that never ran has nulls there, and a pending failure leaks nothing through it', async () => {
    const first = await failingRun('bolt-node', await addCycle(true, at(1)), at(1));
    await incident('bolt-node', { firstFailing: first, review: 'PENDING_REVIEW', summary: CAUSE });
    const rows = await anon<Row>(dsql`select * from public_tools order by slug`);
    const acme = rows.find((r) => r['slug'] === 'acme-node') as Row;
    expect(acme['last_run_id']).toBeNull();
    expect(acme['last_outcome']).toBeNull();
    expect(text(rows)).not.toContain('ZZ');
  });
});

d('every public view: readable by anon, writable by nobody, base tables closed', () => {
  it.each(['public_tools', 'public_runs', 'public_incidents', 'public_run_history'])(
    '%s',
    async (view) => {
      await anon(dsql.raw(`select * from ${view} limit 1`));
      await expect(
        t.handle.db.transaction(async (tx) => {
          await tx.execute(dsql`set local role anon`);
          await tx.execute(dsql.raw(`insert into ${view} default values`));
        }),
      ).rejects.toBeDefined();
    },
  );

  it('anon still cannot read a base table', async () => {
    for (const table of ['runs', 'incidents', 'step_results', 'doc_snapshots', 'compiled_plans'])
      await expect(anon(dsql.raw(`select * from ${table}`))).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/permission denied/) },
      });
  });
});
