import { and, desc, eq } from 'drizzle-orm';
import { compile, COMPILER_VERSION, LlmError, resolveConfig, type LlmClient } from '@qsr/compiler';
import {
  compileConfigHash,
  contentHash,
  Target,
  type Logger,
  type CompileBody,
  type CompileResponse,
  type PlanPayload,
} from '@qsr/core';
import { compiledPlans, docSnapshots, probeCycles, tools } from '@qsr/db';
import { createDbPlanCache } from '../db-plan-cache.js';
import type { Ctx } from '../deps.js';
import { BudgetExceededError, CallLimitError, GuardedLlm } from '../llm-guard.js';
import { HttpError } from '../problem.js';
import { queueOnce } from './queue.js';

// POST /internal/compile (spec section 11) plus the model-token budget (P6).
//
// A model that is out of budget, out of quota, down or too slow is DEFERRED. It is never recorded as
// COMPILER_ERROR (that means "the compiler rejected the plan twice", a statement about our code) and it
// never reaches the status engine. The tool simply keeps its last plan, or is skipped for one cycle.

/** Spec/brief: at most 2 model calls per compile request. */
export const MAX_MODEL_CALLS = 2;

type Row = typeof compiledPlans.$inferSelect;

export function toPayload(row: Row): PlanPayload {
  return {
    id: row.id,
    contentHash: row.contentHash,
    configHash: row.configHash,
    compilerVersion: row.compilerVersion,
    model: row.model,
    accepted: row.accepted,
    ir: row.ir as PlanPayload['ir'],
    groundingReport: row.groundingReport as PlanPayload['groundingReport'],
    truncation: row.truncation as PlanPayload['truncation'],
    createdAt: row.createdAt.toISOString(),
  };
}

type Deferral = 'llm_budget' | 'llm_unavailable' | 'llm_timeout';
const TIMEOUT = Symbol('timeout');

export async function compileForTool(
  ctx: Ctx,
  body: CompileBody,
  log: Logger,
): Promise<CompileResponse> {
  const { db, deps } = ctx;
  const { config } = deps;

  if ((body.extraction === undefined) === (body.crawlError === undefined))
    throw new HttpError(400, 'Bad Request', 'Send exactly one of "extraction" and "crawlError".');

  const [cycle] = await db.select().from(probeCycles).where(eq(probeCycles.id, body.cycleId));
  if (!cycle) throw new HttpError(404, 'Not Found', 'No such cycle.');
  if (cycle.finishedAt !== null)
    throw new HttpError(409, 'Conflict', 'This cycle is already finished.');
  const [tool] = await db.select().from(tools).where(eq(tools.slug, body.toolSlug));
  if (!tool) throw new HttpError(404, 'Not Found', 'No such tool.');
  if (!tool.enabled) throw new HttpError(409, 'Conflict', 'This tool is disabled.');

  if (body.crawlError) {
    await queueOnce(db, {
      reason: 'crawl_error',
      toolId: tool.id,
      cycleId: cycle.id,
      detail: { reason: body.crawlError.reason, message: body.crawlError.message },
    });
    return { status: 'crawl_error', failureClass: 'CRAWL_ERROR' };
  }

  const extraction = body.extraction as NonNullable<CompileBody['extraction']>;
  const target = Target.parse(tool.config);
  // Never trust a hash a runner sends: a forged one would put somebody else's plan under these blocks. The stored
  // target says how the hash is made (hashIgnore: a page value that rotates by itself is left out of the hash).
  if (
    extraction.contentHash !==
    contentHash(extraction.blocks, extraction.variants, target.extract.hashIgnore)
  )
    throw new HttpError(
      400,
      'Bad Request',
      'The extraction content hash does not match its blocks.',
    );

  const configHash = compileConfigHash(target);
  const [snapshot] = await db
    .insert(docSnapshots)
    .values({
      toolId: tool.id,
      contentHash: extraction.contentHash,
      extraction,
      firstSeenAt: deps.now(),
      lastSeenAt: deps.now(),
    })
    .onConflictDoUpdate({
      target: [docSnapshots.toolId, docSnapshots.contentHash],
      set: { lastSeenAt: deps.now() },
    })
    .returning({ id: docSnapshots.id });
  const snapshotId = (snapshot as { id: string }).id;

  const defer = async (
    reason: Deferral,
    retryAfterS: number | null = null,
  ): Promise<CompileResponse> => {
    const [stale] = await db
      .select()
      .from(compiledPlans)
      .where(and(eq(compiledPlans.toolId, tool.id), eq(compiledPlans.accepted, true)))
      .orderBy(desc(compiledPlans.createdAt))
      .limit(1);
    if (!stale) {
      await queueOnce(db, {
        reason: 'compile_deferred',
        toolId: tool.id,
        cycleId: cycle.id,
        detail: { reason },
      });
    }
    return {
      status: 'deferred',
      reason,
      snapshotId,
      stale: stale !== undefined,
      plan: stale ? toPayload(stale) : null,
      retryAfterSeconds: retryAfterS === null ? null : Math.ceil(retryAfterS),
    };
  };

  // No model at all, or the plan job says its time is up: a cache hit can still be served, so look first.
  const modelOff = deps.llm === null || !body.modelAllowed;
  if (modelOff) {
    const hit = await createDbPlanCache(db, tool, configHash).get({
      toolSlug: tool.slug,
      contentHash: extraction.contentHash,
      compilerVersion: COMPILER_VERSION,
    });
    if (!hit) return defer(body.modelAllowed ? 'llm_unavailable' : 'llm_timeout');
  }

  const guarded = new GuardedLlm({
    db,
    inner: (modelOff ? NO_MODEL : (deps.llm as LlmClient)) as LlmClient,
    purpose: 'compile',
    budget: config.groqDailyTokenBudget,
    maxCalls: MAX_MODEL_CALLS,
    now: deps.now,
    model: config.compilerModel ?? resolveConfig().model,
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      compile(target, extraction, {
        llm: guarded,
        cache: createDbPlanCache(db, tool, configHash),
        config: resolveConfig(config.compilerModel ? { model: config.compilerModel } : {}),
        log,
        clock: deps.now,
      }),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), config.compileTimeoutMs);
      }),
    ]);
    if (outcome === TIMEOUT) return defer('llm_timeout');

    const [row] = await db
      .select()
      .from(compiledPlans)
      .where(
        and(
          eq(compiledPlans.toolId, tool.id),
          eq(compiledPlans.contentHash, extraction.contentHash),
          eq(compiledPlans.configHash, configHash),
          eq(compiledPlans.compilerVersion, COMPILER_VERSION),
        ),
      );
    if (!row) throw new Error('compiled plan was not stored');
    const plan = toPayload(row);

    if (outcome.plan.accepted)
      return { status: 'ok', fromCache: outcome.fromCache, stale: false, snapshotId, plan };

    await queueOnce(db, {
      reason: 'compiler_error',
      toolId: tool.id,
      cycleId: cycle.id,
      detail: { violations: outcome.plan.groundingReport.violations.slice(0, 20) },
    });
    return { status: 'compiler_error', failureClass: 'COMPILER_ERROR', snapshotId, plan };
  } catch (err) {
    if (err instanceof BudgetExceededError || err instanceof CallLimitError)
      return defer('llm_budget');
    if (err instanceof LlmError) return defer('llm_unavailable', err.retryAfterS);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const NO_MODEL: LlmClient = {
  complete: async () => {
    throw new LlmError('no model is configured', 'unavailable');
  },
};
