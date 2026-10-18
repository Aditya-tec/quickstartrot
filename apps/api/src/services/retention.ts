import { and, eq, inArray, isNotNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { PIPELINE, type Logger, type RetentionResponse } from '@qsr/core';
import { incidents, runs, stepResults } from '@qsr/db';
import type { Ctx } from '../deps.js';

// The database half of retention (the storage half is services/gc.ts). The stdout/stderr TAILS of PASSING steps older than the log
// retention are set to NULL: a passing step's tail is not evidence of anything, a failing step's is, and so is everything an incident
// links (its first failing and last passing run). Nothing is deleted: the rows stay, so a run still lists its steps and outcomes.
// A dry run says what would be cleared and changes nothing; it is the default of the endpoint.

const DAY = 24 * 60 * 60 * 1000;
export const TAIL_RETENTION_DAYS = PIPELINE.logRetentionDays;

export async function retainStepTails(
  ctx: Ctx,
  opts: { dryRun: boolean },
  log?: Logger,
): Promise<RetentionResponse> {
  const { db, deps } = ctx;
  const cutoff = new Date(deps.now().getTime() - TAIL_RETENTION_DAYS * DAY);

  const linkedRows = await db
    .select({ first: incidents.firstFailingRunId, last: incidents.lastPassingRunId })
    .from(incidents);
  const linked = linkedRows
    .flatMap((r) => [r.first, r.last])
    .filter((id): id is string => id !== null);

  const inScope = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(lt(runs.finishedAt, cutoff), linked.length > 0 ? notInArray(runs.id, linked) : undefined),
    );
  const where = and(
    eq(stepResults.outcome, 'PASS'),
    or(isNotNull(stepResults.stdoutTail), isNotNull(stepResults.stderrTail)),
    inArray(stepResults.runId, inScope),
  );

  const [counted] = await db
    .select({
      steps: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(octet_length(coalesce(${stepResults.stdoutTail}, '')) + octet_length(coalesce(${stepResults.stderrTail}, ''))), 0)::bigint`,
    })
    .from(stepResults)
    .where(where);
  const steps = Number(counted?.steps ?? 0);
  const bytes = Number(counted?.bytes ?? 0);

  if (!opts.dryRun && steps > 0)
    await db.update(stepResults).set({ stdoutTail: null, stderrTail: null }).where(where);
  log?.info(
    { dryRun: opts.dryRun, steps, bytes, cutoff: cutoff.toISOString() },
    'step tail retention',
  );
  return { dryRun: opts.dryRun, cutoff: cutoff.toISOString(), steps, bytes };
}
