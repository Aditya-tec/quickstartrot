import { and, eq } from 'drizzle-orm';
import { CompiledPlan, type PlanCache, type PlanKey } from '@qsr/compiler';
import { GroundingReport, StepIR, Truncation } from '@qsr/core';
import { compiledPlans, type Db } from '@qsr/db';

type Row = typeof compiledPlans.$inferSelect;

/** A database row as the compiler's CompiledPlan; a row that no longer parses is a miss, never a crash. */
export function rowToPlan(row: Row, toolSlug: string): CompiledPlan | null {
  const parsed = CompiledPlan.safeParse({
    toolSlug,
    contentHash: row.contentHash,
    compilerVersion: row.compilerVersion,
    model: row.model,
    ir: row.ir === null ? null : (StepIR.safeParse(row.ir).data ?? 'invalid'),
    groundingReport: GroundingReport.safeParse(row.groundingReport).data ?? 'invalid',
    accepted: row.accepted,
    truncation: Truncation.safeParse(row.truncation).data ?? 'invalid',
    createdAt: row.createdAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The compiler's plan cache over `compiled_plans`, for ONE tool and ONE config hash. The compiler keys on
 * (tool, content hash, compiler version); the config hash (placeholders, level, language, extract.variants)
 * is the fourth part of the key of migration 0003, fixed per request here.
 */
export function createDbPlanCache(
  db: Db,
  tool: { id: string; slug: string },
  configHash: string,
): PlanCache {
  return {
    async get(key: PlanKey) {
      const [row] = await db
        .select()
        .from(compiledPlans)
        .where(
          and(
            eq(compiledPlans.toolId, tool.id),
            eq(compiledPlans.contentHash, key.contentHash),
            eq(compiledPlans.configHash, configHash),
            eq(compiledPlans.compilerVersion, key.compilerVersion),
          ),
        );
      return row ? rowToPlan(row, tool.slug) : null;
    },

    async put(plan: CompiledPlan) {
      await db
        .insert(compiledPlans)
        .values({
          toolId: tool.id,
          contentHash: plan.contentHash,
          configHash,
          compilerVersion: plan.compilerVersion,
          model: plan.model,
          ir: plan.ir,
          groundingReport: plan.groundingReport,
          accepted: plan.accepted,
          truncation: plan.truncation,
        })
        .onConflictDoNothing();
    },
  };
}
