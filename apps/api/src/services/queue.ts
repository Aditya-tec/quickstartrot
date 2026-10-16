import { and, eq, isNull } from 'drizzle-orm';
import { adminQueueItems, type Db } from '@qsr/db';

type Executor = Pick<Db, 'select' | 'insert'>;

/**
 * An admin queue item for something that is not tied to a single run (a crawl or compile problem, a
 * deferred compile). One OPEN item per (tool, cycle, reason): the same problem reported twice is one item.
 */
export async function queueOnce(
  db: Executor,
  item: { reason: string; toolId: string; cycleId: string; detail: Record<string, unknown> },
): Promise<void> {
  const [existing] = await db
    .select({ id: adminQueueItems.id })
    .from(adminQueueItems)
    .where(
      and(
        eq(adminQueueItems.toolId, item.toolId),
        eq(adminQueueItems.cycleId, item.cycleId),
        eq(adminQueueItems.reason, item.reason),
        eq(adminQueueItems.state, 'OPEN'),
        isNull(adminQueueItems.runId),
      ),
    );
  if (existing) return;
  await db.insert(adminQueueItems).values(item);
}
