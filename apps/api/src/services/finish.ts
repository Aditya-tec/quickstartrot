import { and, desc, eq, ne } from 'drizzle-orm';
import { evaluate } from '@qsr/status';
import {
  checkCanaries,
  FinishResponse,
  RECURRENCE_WINDOW_DAYS,
  type CanaryObservation,
  type Logger,
  type StatusEvent,
  type StatusRun,
  type ToolState,
} from '@qsr/core';
import { adminQueueItems, probeCycles, runs, tools } from '@qsr/db';
import type { Ctx } from '../deps.js';
import { HttpError } from '../problem.js';
import { enrichIncident } from './enrichment.js';
import { applyEvent, incidentContext, type Applied } from './incidents.js';
import { notifyWeb } from './revalidate.js';

// POST /internal/cycles/:id/finish (spec section 11, "Cycle finish transaction"):
//   1. SELECT ... FOR UPDATE the cycle; if it is already finished, return the stored result.
//   2. Check every canary against its expected outcome and class; set canary_ok and valid.
//   3. If valid, for each tool take its final attempt, load the tool FOR UPDATE, call evaluate(), write the new
//      state and apply the events. If invalid: no transitions at all, one cycle_ignored note.
//   4. After the commit, best effort: enrich each newly opened incident, then ask the web app to revalidate.
//   5. finished_at is set inside the transaction, with the result.
// Why here and not per run: canaries finish at unpredictable times, and applying transitions only to a cycle
// that is known to be valid means a harness bug can never push a vendor into DEGRADED or open an incident.

const DAY_MS = 24 * 60 * 60 * 1000;

type RunRow = typeof runs.$inferSelect;
type ToolRow = typeof tools.$inferSelect;

const stateOf = (t: ToolRow): ToolState => ({
  status: t.status,
  statusSince: t.statusSince?.toISOString() ?? null,
  consecutiveFailures: t.consecutiveFailures,
  consecutivePasses: t.consecutivePasses,
  transientStreak: t.transientStreak,
  lastFailureSignature: t.lastFailureSignature,
  lastFailureClass: t.lastFailureClass,
});

const statusRunOf = (r: RunRow): StatusRun => ({
  outcome: r.outcome,
  failureClass: r.failureClass,
  failureSignature: r.failureSignature,
  reachedLevel: Math.min(4, Math.max(0, r.reachedLevel)),
  skipReason: r.skipReason === 'manual_step' ? 'manual_step' : null,
  finishedAt: r.finishedAt.toISOString(),
});

/** The highest attempt per tool: only the final attempt feeds the status engine (spec section 10). */
function finalAttempts(rows: { run: RunRow; tool: ToolRow }[]): { run: RunRow; tool: ToolRow }[] {
  const best = new Map<string, { run: RunRow; tool: ToolRow }>();
  for (const row of rows) {
    const current = best.get(row.tool.id);
    if (!current || row.run.attempt > current.run.attempt) best.set(row.tool.id, row);
  }
  return [...best.values()];
}

export async function finishCycle(ctx: Ctx, cycleId: string, log: Logger): Promise<FinishResponse> {
  const { db, deps } = ctx;
  const applied: Applied = { opened: [] };

  const result = await db.transaction(async (tx) => {
    const [cycle] = await tx
      .select()
      .from(probeCycles)
      .where(eq(probeCycles.id, cycleId))
      .for('update');
    if (!cycle) throw new HttpError(404, 'Not Found', 'No such cycle.');
    if (cycle.finishedAt !== null && cycle.finishResult !== null) {
      applied.opened = [];
      return { stored: true as const, response: FinishResponse.parse(cycle.finishResult) };
    }

    const rows = await tx
      .select({ run: runs, tool: tools })
      .from(runs)
      .innerJoin(tools, eq(tools.id, runs.toolId))
      .where(eq(runs.cycleId, cycleId));
    const finals = finalAttempts(rows).sort((a, b) => (a.tool.slug < b.tool.slug ? -1 : 1));

    // ---- 2. canaries
    const observations: CanaryObservation[] = finals
      .filter((f) => f.tool.isCanary)
      .map((f) => ({
        slug: f.tool.slug,
        outcome: f.run.outcome,
        failureClass: f.run.failureClass,
      }));
    const canaries = checkCanaries(observations);
    const finishedAt = deps.now();
    await tx
      .update(probeCycles)
      .set({ canaryOk: canaries.ok, valid: canaries.ok })
      .where(eq(probeCycles.id, cycleId));

    const toolResults: FinishResponse['tools'] = [];
    let ignored: string | null = null;

    if (!canaries.ok) {
      // ---- 3b. invalid: nothing is applied, one note
      ignored = `cycle_ignored: the cycle is not valid, so no transition was applied (${canaries.problems.join('; ')})`;
      await tx.insert(adminQueueItems).values({
        reason: 'cycle_invalid',
        cycleId,
        detail: { problems: canaries.problems },
      });
    } else {
      // ---- 3a. valid: one tool at a time, locked
      for (const { run: finalRun, tool: unlocked } of finals.filter(
        (f) => !f.tool.isCanary && f.tool.enabled,
      )) {
        const [tool] = await tx.select().from(tools).where(eq(tools.id, unlocked.id)).for('update');
        const current = tool as ToolRow;
        const run = statusRunOf(finalRun);
        const since = new Date(Date.parse(run.finishedAt) - RECURRENCE_WINDOW_DAYS * DAY_MS);
        const incident = await incidentContext(tx, current.id, since);
        const [previous] = await tx
          .select({ level: runs.reachedLevel })
          .from(runs)
          .innerJoin(probeCycles, eq(probeCycles.id, runs.cycleId))
          .where(
            and(
              eq(runs.toolId, current.id),
              eq(probeCycles.valid, true),
              ne(runs.cycleId, cycleId),
            ),
          )
          .orderBy(desc(probeCycles.startedAt), desc(runs.attempt))
          .limit(1);

        const { next, events } = evaluate(stateOf(current), run, {
          cycleValid: true,
          ...incident,
          previousReachedLevel: previous ? Math.min(4, Math.max(0, previous.level)) : null,
        });

        await tx
          .update(tools)
          .set({
            status: next.status,
            statusSince: next.statusSince ? new Date(next.statusSince) : null,
            consecutiveFailures: next.consecutiveFailures,
            consecutivePasses: next.consecutivePasses,
            transientStreak: next.transientStreak,
            lastFailureSignature: next.lastFailureSignature,
            lastFailureClass: next.lastFailureClass,
            lastRunAt: finalRun.finishedAt,
          })
          .where(eq(tools.id, current.id));
        for (const event of events)
          await applyEvent(tx, event, { tool: current, run: finalRun, cycleId }, applied);
        toolResults.push({
          slug: current.slug,
          before: current.status,
          after: next.status,
          events: events as StatusEvent[],
        });
      }
    }

    const response: FinishResponse = {
      cycleId,
      valid: canaries.ok,
      canaryOk: canaries.ok,
      canaryProblems: canaries.problems,
      tools: toolResults,
      ignored,
      finishedAt: finishedAt.toISOString(),
    };
    await tx
      .update(probeCycles)
      .set({ finishedAt, finishResult: response })
      .where(eq(probeCycles.id, cycleId));
    return { stored: false as const, response };
  });

  if (result.stored) return result.response;

  // ---- 4. after the commit: best effort, never blocking
  for (const incidentId of applied.opened) {
    try {
      await enrichIncident(ctx, incidentId, log);
    } catch (err) {
      log.error({ cycleId, incidentId, err }, 'incident enrichment crashed');
      try {
        await db.insert(adminQueueItems).values({
          reason: 'enrichment_failed',
          incidentId,
          cycleId,
          detail: { failed: ['enrichment'] },
        });
      } catch {
        /* nothing more can be done; the incident itself is already safe */
      }
    }
  }
  if (result.response.valid) await notifyWeb(deps, cycleId, log);
  log.info(
    {
      cycleId,
      valid: result.response.valid,
      tools: result.response.tools.length,
      opened: applied.opened.length,
    },
    'cycle finished',
  );
  return result.response;
}
