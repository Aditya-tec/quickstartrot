import { and, asc, eq, sql } from 'drizzle-orm';
import type { CycleBody, CycleResponse } from '@qsr/core';
import { probeCycles, tools, type Db } from '@qsr/db';

/**
 * POST /internal/cycles: create a probe cycle and list the enabled tools. Idempotent on
 * (gh_run_id, gh_run_attempt) via the partial unique index, so a retried plan job (or five at once) ends up
 * with the same cycle.
 */
export async function createCycle(db: Db, body: CycleBody, now: Date): Promise<CycleResponse> {
  const inserted = await db
    .insert(probeCycles)
    .values({
      trigger: body.trigger,
      gitSha: body.gitSha,
      ghRunId: body.ghRunId ?? null,
      ghRunAttempt: body.ghRunAttempt,
      startedAt: now,
    })
    .onConflictDoNothing({
      target: [probeCycles.ghRunId, probeCycles.ghRunAttempt],
      where: sql`${probeCycles.ghRunId} is not null`,
    })
    .returning({ id: probeCycles.id });

  let cycleId = inserted[0]?.id;
  const created = cycleId !== undefined;
  if (cycleId === undefined && body.ghRunId !== undefined) {
    const [existing] = await db
      .select({ id: probeCycles.id })
      .from(probeCycles)
      .where(
        and(eq(probeCycles.ghRunId, body.ghRunId), eq(probeCycles.ghRunAttempt, body.ghRunAttempt)),
      );
    cycleId = existing?.id;
  }
  if (cycleId === undefined) throw new Error('cycle insert returned no row and none exists');

  const enabled = await db
    .select({
      slug: tools.slug,
      name: tools.name,
      docsUrl: tools.docsUrl,
      language: tools.language,
      level: tools.level,
      isCanary: tools.isCanary,
    })
    .from(tools)
    .where(eq(tools.enabled, true))
    .orderBy(asc(tools.slug));

  return {
    cycleId,
    created,
    tools: enabled.map((t) => ({
      slug: t.slug,
      name: t.name,
      docsUrl: t.docsUrl,
      language: t.language as 'node' | 'python',
      level: t.level,
      isCanary: t.isCanary ?? false,
    })),
  };
}
