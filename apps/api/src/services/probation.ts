import { sql } from 'drizzle-orm';
import { PROBATION } from '@qsr/core';
import type { Db } from '@qsr/db';

// A target on probation (target file: `probation`) is probed like any other but is in no public number until it has PROBATION.validCycles
// valid cycles. The public views release it by themselves (migration 0010); this is the same rule for the numbers computed here: the
// launch export and the harness error rate. The operator's per-tool tables keep showing it.

/** The ids of the tools that are on probation right now: flagged, and fewer than PROBATION.validCycles valid cycles in which they ran. */
export async function toolsInProbation(db: Db): Promise<Set<string>> {
  const rows = (await db.execute(
    sql`select t.id from tools t
        where t.probation
          and (select count(distinct r.cycle_id) from runs r
               join probe_cycles c on c.id = r.cycle_id and c.valid is true
               where r.tool_id = t.id) < ${PROBATION.validCycles}`,
  )) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}
