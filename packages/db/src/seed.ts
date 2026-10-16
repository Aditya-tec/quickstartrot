import { inArray, like } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { createDb, type Db } from './client.js';
import {
  compiledPlans,
  docSnapshots,
  incidentEvents,
  incidents,
  probeCycles,
  runs,
  stepResults,
  tools,
} from './schema.js';

/** Every seeded tool slug starts with this prefix, so unseed never touches real data. */
export const SEED_PREFIX = 'seed-';
export const SEED_SLUGS = {
  healthy: 'seed-healthy-node',
  pending: 'seed-pending-python',
  confirmed: 'seed-confirmed-node',
} as const;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/** Removes everything the seed created. FK order: leaves first. */
export async function unseed(db: Db): Promise<void> {
  const seedTools = await db
    .select({ id: tools.id })
    .from(tools)
    .where(like(tools.slug, `${SEED_PREFIX}%`));
  const toolIds = seedTools.map((t) => t.id);
  if (toolIds.length === 0) return;

  const seedRuns = await db
    .select({ id: runs.id, cycleId: runs.cycleId })
    .from(runs)
    .where(inArray(runs.toolId, toolIds));
  const seedIncidents = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(inArray(incidents.toolId, toolIds));
  const incidentIds = seedIncidents.map((i) => i.id);
  const runIds = seedRuns.map((r) => r.id);
  const cycleIds = [...new Set(seedRuns.map((r) => r.cycleId))];

  if (incidentIds.length)
    await db.delete(incidentEvents).where(inArray(incidentEvents.incidentId, incidentIds));
  if (incidentIds.length) await db.delete(incidents).where(inArray(incidents.id, incidentIds));
  if (runIds.length) await db.delete(stepResults).where(inArray(stepResults.runId, runIds)); // also cascades
  if (runIds.length) await db.delete(runs).where(inArray(runs.id, runIds));
  if (cycleIds.length) await db.delete(probeCycles).where(inArray(probeCycles.id, cycleIds));
  await db.delete(compiledPlans).where(inArray(compiledPlans.toolId, toolIds));
  await db.delete(docSnapshots).where(inArray(docSnapshots.toolId, toolIds));
  await db.delete(tools).where(inArray(tools.id, toolIds));
}

function toolRow(
  slug: string,
  name: string,
  language: 'node' | 'python',
  extra: Partial<typeof tools.$inferInsert>,
) {
  return {
    slug,
    name,
    docsUrl: `https://example.com/docs/${slug}`,
    language,
    level: 3,
    config: { slug, name, language, level: 3, fake: true },
    configHash: `seed-${slug}`,
    ...extra,
  } satisfies typeof tools.$inferInsert;
}

/**
 * 3 fake tools with runs, covering the public status mapping:
 *  - healthy:   HEALTHY, passing runs in valid cycles, plus one run in an INVALID cycle.
 *  - pending:   internal BROKEN with a PENDING_REVIEW incident => public DEGRADED ("verifying").
 *  - confirmed: internal BROKEN with a CONFIRMED incident       => public BROKEN.
 */
export async function seed(db: Db): Promise<void> {
  await unseed(db);

  const [healthy, pending, confirmed] = await db
    .insert(tools)
    .values([
      toolRow(SEED_SLUGS.healthy, 'Seed Healthy (Node)', 'node', {
        status: 'HEALTHY',
        statusSince: hoursAgo(30),
        consecutivePasses: 5,
        lastRunAt: hoursAgo(1),
      }),
      toolRow(SEED_SLUGS.pending, 'Seed Pending (Python)', 'python', {
        status: 'BROKEN',
        statusSince: hoursAgo(7),
        consecutiveFailures: 2,
        lastRunAt: hoursAgo(1),
      }),
      toolRow(SEED_SLUGS.confirmed, 'Seed Confirmed (Node)', 'node', {
        status: 'BROKEN',
        statusSince: hoursAgo(20),
        consecutiveFailures: 4,
        lastRunAt: hoursAgo(1),
      }),
    ])
    .returning();
  if (!healthy || !pending || !confirmed) throw new Error('seed: tool insert failed');

  const [snapshot] = await db
    .insert(docSnapshots)
    .values({ toolId: healthy.id, contentHash: 'seed-hash-1', extraction: { blocks: [] } })
    .returning();
  const [plan] = await db
    .insert(compiledPlans)
    .values({
      toolId: healthy.id,
      contentHash: 'seed-hash-1',
      compilerVersion: 'seed',
      model: 'seed-model',
      ir: { irVersion: 1, steps: [] },
      groundingReport: { ok: true, violations: [] },
      accepted: true,
    })
    .returning();

  const [c1, c2, bad] = await db
    .insert(probeCycles)
    .values([
      {
        trigger: 'manual',
        gitSha: 'seed',
        canaryOk: true,
        valid: true,
        startedAt: hoursAgo(13),
        finishedAt: hoursAgo(12),
      },
      {
        trigger: 'manual',
        gitSha: 'seed',
        canaryOk: true,
        valid: true,
        startedAt: hoursAgo(7),
        finishedAt: hoursAgo(6),
      },
      {
        trigger: 'manual',
        gitSha: 'seed',
        canaryOk: false,
        valid: false,
        startedAt: hoursAgo(2),
        finishedAt: hoursAgo(1),
      },
    ])
    .returning();
  if (!c1 || !c2 || !bad) throw new Error('seed: cycle insert failed');

  const base = {
    imageDigest: 'sha256:seed',
    runnerEnv: { node: 'v22.0.0', os: 'ubuntu-24.04' },
    durationMs: 4200,
  };
  const when = (h: number) => ({ startedAt: hoursAgo(h), finishedAt: hoursAgo(h - 0.05) });

  const insertedRuns = await db
    .insert(runs)
    .values([
      {
        ...base,
        ...when(13),
        cycleId: c1.id,
        toolId: healthy.id,
        planId: plan?.id ?? null,
        snapshotId: snapshot?.id ?? null,
        outcome: 'PASS',
      },
      {
        ...base,
        ...when(7),
        cycleId: c2.id,
        toolId: healthy.id,
        planId: plan?.id ?? null,
        snapshotId: snapshot?.id ?? null,
        outcome: 'PASS',
      },
      // Run from an invalid cycle: must never reach public_runs or the pass rate.
      {
        ...base,
        ...when(2),
        cycleId: bad.id,
        toolId: healthy.id,
        outcome: 'FAIL',
        failureClass: 'HARNESS_ERROR',
      },
      {
        ...base,
        ...when(13),
        cycleId: c1.id,
        toolId: pending.id,
        outcome: 'FAIL',
        failureClass: 'API_DRIFT',
        failureSignature: 'seed-sig-pending',
        failedStepId: 'run-1',
        classifierRule: 'drift.not_a_function',
      },
      {
        ...base,
        ...when(7),
        cycleId: c2.id,
        toolId: pending.id,
        outcome: 'FAIL',
        failureClass: 'API_DRIFT',
        failureSignature: 'seed-sig-pending',
        failedStepId: 'run-1',
        classifierRule: 'drift.not_a_function',
      },
      {
        ...base,
        ...when(13),
        cycleId: c1.id,
        toolId: confirmed.id,
        outcome: 'FAIL',
        failureClass: 'DEPENDENCY_RESOLUTION',
        failureSignature: 'seed-sig-confirmed',
        failedStepId: 'install-1',
        classifierRule: 'dep.npm_404',
      },
      {
        ...base,
        ...when(7),
        cycleId: c2.id,
        toolId: confirmed.id,
        outcome: 'FAIL',
        failureClass: 'DEPENDENCY_RESOLUTION',
        failureSignature: 'seed-sig-confirmed',
        failedStepId: 'install-1',
        classifierRule: 'dep.npm_404',
      },
    ])
    .returning();

  await db.insert(stepResults).values(
    insertedRuns.flatMap((r) => [
      {
        runId: r.id,
        stepId: 'install-1',
        ordinal: 0,
        kind: 'shell',
        outcome: r.outcome === 'FAIL' && r.failedStepId === 'install-1' ? 'FAIL' : 'PASS',
        exitCode: r.failedStepId === 'install-1' ? 1 : 0,
        durationMs: 1500,
        stdoutTail: 'added 1 package',
        stderrTail: null,
      },
      {
        runId: r.id,
        stepId: 'run-1',
        ordinal: 1,
        kind: 'run',
        outcome:
          r.failedStepId === 'run-1' ? 'FAIL' : r.failedStepId === 'install-1' ? 'SKIPPED' : 'PASS',
        exitCode: r.failedStepId === 'run-1' ? 1 : r.failedStepId === 'install-1' ? null : 0,
        durationMs: 800,
        stdoutTail: null,
        stderrTail: r.failedStepId === 'run-1' ? 'TypeError: client.send is not a function' : null,
      },
    ]),
  );

  const firstFail = (toolId: string) =>
    insertedRuns.find((r) => r.toolId === toolId && r.cycleId === c1.id)?.id ?? null;
  const [pendingIncident, confirmedIncident] = await db
    .insert(incidents)
    .values([
      {
        toolId: pending.id,
        signature: 'seed-sig-pending',
        failureClass: 'API_DRIFT',
        review: 'PENDING_REVIEW',
        firstFailingRunId: firstFail(pending.id),
        summary: 'DRAFT: send() was renamed.',
        openedAt: hoursAgo(7),
      },
      {
        toolId: confirmed.id,
        signature: 'seed-sig-confirmed',
        failureClass: 'DEPENDENCY_RESOLUTION',
        review: 'CONFIRMED',
        firstFailingRunId: firstFail(confirmed.id),
        summary: 'The install command references a package version that does not exist.',
        suggestedFix: 'Update the version in the install command.',
        openedAt: hoursAgo(12),
        confirmedAt: hoursAgo(10),
      },
    ])
    .returning();
  if (!pendingIncident || !confirmedIncident) throw new Error('seed: incident insert failed');

  await db.insert(incidentEvents).values([
    { incidentId: pendingIncident.id, type: 'opened', at: hoursAgo(7) },
    { incidentId: confirmedIncident.id, type: 'opened', at: hoursAgo(12) },
    {
      incidentId: confirmedIncident.id,
      type: 'note',
      payload: { text: 'internal only' },
      at: hoursAgo(11),
    },
    { incidentId: confirmedIncident.id, type: 'confirmed', at: hoursAgo(10) },
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  const { db, close } = createDb(url, { max: 1 });
  try {
    await seed(db);
    console.log(JSON.stringify({ msg: 'seeded', slugs: Object.values(SEED_SLUGS) }));
  } finally {
    await close();
  }
}
