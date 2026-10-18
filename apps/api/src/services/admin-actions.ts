import { eq } from 'drizzle-orm';
import {
  VENDOR_FAILURE_CLASSES,
  type ConfirmBody,
  type FalsePositiveBody,
  type Logger,
} from '@qsr/core';
import { adminQueueItems, incidentEvents, incidents, runs, tools } from '@qsr/db';
import type { Ctx } from '../deps.js';
import { HttpError } from '../problem.js';
import { notifyWeb } from './revalidate.js';

// The admin review actions (spec section 11). Nothing is public BROKEN without a human: these are the human.

async function loadIncident(ctx: Ctx, id: string) {
  const [incident] = await ctx.db.select().from(incidents).where(eq(incidents.id, id));
  if (!incident) throw new HttpError(404, 'Not Found', 'No such incident.');
  return incident;
}

/** POST /admin/incidents/:id/confirm: the edited summary and fix become public. */
export async function confirmIncident(
  ctx: Ctx,
  id: string,
  body: ConfirmBody,
  log: Logger,
): Promise<{ id: string }> {
  const incident = await loadIncident(ctx, id);
  if (incident.state !== 'OPEN' || incident.review !== 'PENDING_REVIEW')
    throw new HttpError(409, 'Conflict', 'This incident is not waiting for review.');
  // docs/DISCLOSURE.md: only a failure the vendor owns can be published. A transient one (the registry, the
  // network, a timeout) and one on our side (crawler, compiler, runner) is never public, whoever reviews it.
  if (!(VENDOR_FAILURE_CLASSES as readonly string[]).includes(incident.failureClass))
    throw new HttpError(
      409,
      'Conflict',
      `A ${incident.failureClass} incident is never published as a vendor's failure. Mark it a false positive if it is not one.`,
    );
  const now = ctx.deps.now();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(incidents)
      .set({
        review: 'CONFIRMED',
        confirmedAt: now,
        summary: body.summary,
        suggestedFix: body.suggestedFix,
      })
      .where(eq(incidents.id, id));
    await tx
      .insert(incidentEvents)
      .values({ incidentId: id, type: 'confirmed', payload: {}, at: now });
  });
  await notifyWeb(ctx.deps, `incident:${id}`, log);
  return { id };
}

/**
 * POST /admin/incidents/:id/false-positive: resolves the incident, resets the tool's streaks (the failure was
 * our classification's fault, not the vendor's) and leaves a classifier-rule TODO in the queue.
 */
export async function markFalsePositive(
  ctx: Ctx,
  id: string,
  body: FalsePositiveBody,
  log: Logger,
): Promise<{ id: string }> {
  const incident = await loadIncident(ctx, id);
  if (incident.state !== 'OPEN')
    throw new HttpError(409, 'Conflict', 'This incident is already resolved.');
  const now = ctx.deps.now();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(incidents)
      .set({ state: 'RESOLVED', review: 'FALSE_POSITIVE', resolvedAt: now })
      .where(eq(incidents.id, id));
    await tx.insert(incidentEvents).values({
      incidentId: id,
      type: 'false_positive',
      payload: { reason: body.reason },
      at: now,
    });
    await tx
      .update(tools)
      .set({
        status: 'HEALTHY',
        statusSince: now,
        consecutiveFailures: 0,
        consecutivePasses: 0,
        transientStreak: 0,
        lastFailureSignature: null,
        lastFailureClass: null,
        lastFailureHarnessVersion: null,
      })
      .where(eq(tools.id, incident.toolId));
    const [failingRun] = incident.firstFailingRunId
      ? await tx
          .select({ rule: runs.classifierRule })
          .from(runs)
          .where(eq(runs.id, incident.firstFailingRunId))
      : [];
    await tx.insert(adminQueueItems).values({
      reason: 'rule_todo',
      toolId: incident.toolId,
      incidentId: id,
      detail: {
        signature: incident.signature,
        failureClass: incident.failureClass,
        classifierRule: failingRun?.rule ?? null,
        reason: body.reason,
      },
    });
  });
  await notifyWeb(ctx.deps, `incident:${id}`, log);
  return { id };
}

/** POST /admin/tools/:slug/disable: a vendor opt-out or a robots change. A re-sync never undoes it. */
export async function disableTool(ctx: Ctx, slug: string, log: Logger): Promise<{ slug: string }> {
  const updated = await ctx.db
    .update(tools)
    .set({ enabled: false, disabledReason: 'admin' })
    .where(eq(tools.slug, slug))
    .returning({ slug: tools.slug });
  if (updated.length === 0) throw new HttpError(404, 'Not Found', 'No such tool.');
  await notifyWeb(ctx.deps, `tool:${slug}`, log);
  return { slug };
}
