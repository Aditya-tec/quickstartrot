import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { StatusEvent } from '@qsr/core';
import {
  adminQueueItems,
  incidentEvents,
  incidents,
  probeCycles,
  runs,
  type Db,
  type tools,
} from '@qsr/db';

// Applying the status engine's events to the database. Everything here runs inside the cycle-finish
// transaction (`tx`), so a failure rolls the whole cycle back and the next call starts again.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Run = typeof runs.$inferSelect;
type Tool = typeof tools.$inferSelect;

export interface Applied {
  /** Incidents this cycle opened (not reopened): they get enrichment after the commit. */
  opened: string[];
}

/**
 * The run that began the current streak of failures with this signature, and the last run that passed before
 * it. Final attempts of valid cycles only, newest first, as a person reads the history.
 */
async function streakBounds(
  tx: Tx,
  toolId: string,
  signature: string,
): Promise<{ firstFailing: string | null; lastPassing: string | null }> {
  const rows = await tx
    .select({ run: runs, cycleStartedAt: probeCycles.startedAt })
    .from(runs)
    .innerJoin(probeCycles, eq(probeCycles.id, runs.cycleId))
    .where(and(eq(runs.toolId, toolId), eq(probeCycles.valid, true)))
    .orderBy(desc(probeCycles.startedAt), desc(runs.attempt))
    .limit(120);
  const seen = new Set<string>();
  const finals = rows.filter(({ run }) =>
    seen.has(run.cycleId) ? false : (seen.add(run.cycleId), true),
  );
  let firstFailing: string | null = null;
  let lastPassing: string | null = null;
  let inStreak = true;
  for (const { run } of finals) {
    if (inStreak && run.failureSignature === signature) {
      firstFailing = run.id;
      continue;
    }
    inStreak = false;
    if (run.outcome === 'PASS') {
      lastPassing = run.id;
      break;
    }
  }
  return { firstFailing, lastPassing };
}

export async function applyEvent(
  tx: Tx,
  event: StatusEvent,
  at: { tool: Tool; run: Run; cycleId: string },
  applied: Applied,
): Promise<void> {
  const { tool, run, cycleId } = at;
  const when = run.finishedAt;
  switch (event.type) {
    case 'incident_opened': {
      const { firstFailing, lastPassing } = await streakBounds(tx, tool.id, event.signature);
      const [incident] = await tx
        .insert(incidents)
        .values({
          toolId: tool.id,
          signature: event.signature,
          failureClass: event.failureClass,
          state: 'OPEN',
          review: 'PENDING_REVIEW',
          firstFailingRunId: firstFailing ?? run.id,
          lastPassingRunId: lastPassing,
          openedAt: when,
        })
        .returning({ id: incidents.id });
      const id = (incident as { id: string }).id;
      await tx.insert(incidentEvents).values({
        incidentId: id,
        type: 'opened',
        payload: {
          signature: event.signature,
          failureClass: event.failureClass,
          trigger: event.trigger,
          runId: run.id,
        },
        at: when,
      });
      applied.opened.push(id);
      return;
    }
    case 'incident_resolved':
      await tx
        .update(incidents)
        .set({ state: 'RESOLVED', resolvedAt: when })
        .where(eq(incidents.id, event.incidentId));
      await tx.insert(incidentEvents).values({
        incidentId: event.incidentId,
        type: 'resolved',
        payload: { runId: run.id },
        at: when,
      });
      return;
    case 'incident_signature_changed':
      await tx
        .update(incidents)
        .set({ signature: event.to, failureClass: event.failureClass })
        .where(eq(incidents.id, event.incidentId));
      await tx.insert(incidentEvents).values({
        incidentId: event.incidentId,
        type: 'signature_changed',
        payload: {
          from: event.from,
          to: event.to,
          failureClass: event.failureClass,
          runId: run.id,
        },
        at: when,
      });
      return;
    case 'incident_recurred':
      // Reopen the SAME incident. It needs a person again: nothing is public BROKEN without review.
      await tx
        .update(incidents)
        .set({ state: 'OPEN', resolvedAt: null, review: 'PENDING_REVIEW', confirmedAt: null })
        .where(eq(incidents.id, event.incidentId));
      await tx.insert(incidentEvents).values({
        incidentId: event.incidentId,
        type: 'recurred',
        payload: { signature: event.signature, failureClass: event.failureClass, runId: run.id },
        at: when,
      });
      return;
    case 'admin_queue':
      await tx
        .insert(adminQueueItems)
        .values({
          reason: event.reason,
          toolId: tool.id,
          runId: run.id,
          cycleId,
          detail: {
            failureClass: event.failureClass,
            signature: event.signature,
            detail: event.detail,
          },
        })
        .onConflictDoNothing();
      return;
    case 'cycle_ignored':
      return;
  }
}

/** The tool's single open incident, if any, and the incidents it resolved since `since` (false positives excluded). */
export async function incidentContext(tx: Tx, toolId: string, since: Date) {
  const [open] = await tx
    .select()
    .from(incidents)
    .where(and(eq(incidents.toolId, toolId), eq(incidents.state, 'OPEN')));
  const resolved = await tx
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.toolId, toolId),
        eq(incidents.state, 'RESOLVED'),
        ne(incidents.review, 'FALSE_POSITIVE'),
        inArray(incidents.review, ['PENDING_REVIEW', 'CONFIRMED']),
      ),
    );
  return {
    openIncident: open
      ? { id: open.id, signature: open.signature, failureClass: open.failureClass }
      : null,
    recentlyResolvedIncidents: resolved
      .filter((i) => i.resolvedAt !== null && i.resolvedAt >= since)
      .map((i) => ({
        id: i.id,
        signature: i.signature,
        resolvedAt: (i.resolvedAt as Date).toISOString(),
      })),
  };
}
