import { and, desc, eq } from 'drizzle-orm';
import type { AdminQueueResponse } from '@qsr/core';
import { adminQueueItems, incidents, submissions, tools, type Db } from '@qsr/db';

/**
 * GET /admin/queue: pending incidents, open admin items (UNKNOWN and LLM classifications, crawl, compile
 * and config errors), and new submissions.
 */
export async function loadQueue(db: Db): Promise<AdminQueueResponse> {
  const pending = await db
    .select({ i: incidents, slug: tools.slug })
    .from(incidents)
    .innerJoin(tools, eq(tools.id, incidents.toolId))
    .where(and(eq(incidents.state, 'OPEN'), eq(incidents.review, 'PENDING_REVIEW')))
    .orderBy(desc(incidents.openedAt));
  const items = await db
    .select({ a: adminQueueItems, slug: tools.slug })
    .from(adminQueueItems)
    .leftJoin(tools, eq(tools.id, adminQueueItems.toolId))
    .where(eq(adminQueueItems.state, 'OPEN'))
    .orderBy(desc(adminQueueItems.createdAt));
  const subs = await db
    .select()
    .from(submissions)
    .where(eq(submissions.status, 'NEW'))
    .orderBy(desc(submissions.createdAt));

  return {
    pendingIncidents: pending.map(({ i, slug }) => ({
      id: i.id,
      toolSlug: slug,
      signature: i.signature,
      failureClass: i.failureClass,
      review: i.review,
      openedAt: i.openedAt.toISOString(),
      summary: i.summary,
      suggestedFix: i.suggestedFix,
      docsChanged: i.docsChanged,
    })),
    items: items.map(({ a, slug }) => ({
      id: a.id,
      reason: a.reason,
      toolSlug: slug,
      runId: a.runId,
      cycleId: a.cycleId,
      detail: a.detail,
      createdAt: a.createdAt.toISOString(),
    })),
    submissions: subs.map((s) => ({
      id: s.id,
      docsUrl: s.docsUrl,
      contact: s.contact,
      note: s.note,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}
