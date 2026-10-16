import { and, eq } from 'drizzle-orm';
import {
  classify,
  classifyWithFallback,
  inputFromRunResult,
  unknownClassification,
  type Classification,
  type ClassifyInput,
} from '@qsr/classifier';
import {
  runSkipReason,
  Target,
  type ClassificationPayload,
  type RunBody,
  type RunResponse,
  type StepResult,
} from '@qsr/core';
import {
  adminQueueItems,
  compiledPlans,
  docSnapshots,
  probeCycles,
  runs,
  stepResults,
  tools,
} from '@qsr/db';
import type { Ctx } from '../deps.js';
import { GuardedLlm } from '../llm-guard.js';
import { logPathFor, SAFE_STEP_ID } from '../log-paths.js';
import { HttpError } from '../problem.js';
import { resolveConfig } from '@qsr/compiler';

// POST /internal/runs (spec section 11): store one immutable RunResult, classify it, and stop there. Status
// is applied later, at cycle finish, once the cycle is known to be valid.

/** One model call at most: classification is a fallback, not a pipeline. */
const CLASSIFY_MAX_CALLS = 1;

const sourceOf = (ruleId: string | null): ClassificationPayload['source'] =>
  ruleId === 'llm.fallback' ? 'llm' : ruleId === 'none' || ruleId === null ? 'none' : 'rule';

const toPayload = (c: Classification): ClassificationPayload => ({
  failureClass: c.failureClass,
  ruleId: c.ruleId,
  signature: c.signature,
  evidenceLine: c.evidenceLine,
  source: c.source,
});

export async function ingestRun(ctx: Ctx, body: RunBody): Promise<RunResponse> {
  const { db } = ctx;
  const result = body.runResult;

  const [cycle] = await db.select().from(probeCycles).where(eq(probeCycles.id, result.cycleId));
  if (!cycle) throw new HttpError(404, 'Not Found', 'No such cycle.');
  const [tool] = await db.select().from(tools).where(eq(tools.slug, result.toolSlug));
  if (!tool) throw new HttpError(404, 'Not Found', 'No such tool.');

  // Idempotent: a retried report job gets the stored answer, whatever its body says now.
  const stored = await existingRun(ctx, cycle.id, tool.id, result.attempt);
  if (stored) return stored;

  if (cycle.finishedAt !== null)
    throw new HttpError(409, 'Conflict', 'This cycle is already finished.');
  if (!tool.enabled) throw new HttpError(409, 'Conflict', 'This tool is disabled.');

  // ---- validation: nothing the runner says about plans, snapshots or log paths is trusted
  if (result.planId !== null) {
    const [plan] = await db
      .select({ id: compiledPlans.id })
      .from(compiledPlans)
      .where(and(eq(compiledPlans.id, result.planId), eq(compiledPlans.toolId, tool.id)));
    if (!plan) throw new HttpError(400, 'Bad Request', 'The plan id is not a plan of this tool.');
  }
  const logPaths = validatedLogPaths(ctx, body);
  const snapshot = result.snapshotHash
    ? (
        await db
          .select({ id: docSnapshots.id })
          .from(docSnapshots)
          .where(
            and(
              eq(docSnapshots.toolId, tool.id),
              eq(docSnapshots.contentHash, result.snapshotHash),
            ),
          )
      )[0]
    : undefined;

  // ---- classification: rules first; the model only for a FAIL no rule recognises
  const target = Target.parse(tool.config);
  const failed = result.steps.find((s) => s.stepId === result.failedStepId);
  const input = inputFromRunResult(result, {
    language: target.language,
    targetLevel: target.level,
    authErrorIsPass: failed?.kind === 'run' && target.expect.authErrorIsPass && target.level >= 3,
  });
  const classification = input ? await classifyRun(ctx, input) : null;

  // ---- store
  const durationMs = Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt));
  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(runs)
      .values({
        cycleId: cycle.id,
        toolId: tool.id,
        planId: result.planId,
        snapshotId: snapshot?.id ?? null,
        attempt: result.attempt,
        outcome: result.outcome,
        failureClass: classification?.failureClass ?? null,
        failureSignature: classification?.signature ?? null,
        failedStepId: result.failedStepId,
        classifierRule: classification?.ruleId ?? null,
        reachedLevel: result.reachedLevel,
        skipReason: runSkipReason(result),
        imageDigest: result.imageDigest,
        runnerEnv: result.runnerEnv,
        durationMs,
        startedAt: new Date(result.startedAt),
        finishedAt: new Date(result.finishedAt),
      })
      .onConflictDoNothing({ target: [runs.cycleId, runs.toolId, runs.attempt] })
      .returning({ id: runs.id });
    if (!row) return null;

    // A harness error before any step leaves a run with no steps.
    if (result.steps.length > 0)
      await tx.insert(stepResults).values(
        result.steps.map((s) => ({
          runId: row.id,
          stepId: s.stepId,
          ordinal: s.ordinal,
          kind: s.kind,
          outcome: s.outcome,
          exitCode: s.exitCode,
          durationMs: s.durationMs,
          stdoutTail: s.stdoutTail,
          stderrTail: s.stderrTail,
          logPath: logPaths.get(s.stepId) ?? null,
        })),
      );
    if (classification?.source === 'llm') {
      // Every model classification is listed for a person, so a rule can be written for it.
      await tx.insert(adminQueueItems).values({
        reason: 'llm_classified',
        toolId: tool.id,
        runId: row.id,
        cycleId: cycle.id,
        detail: {
          failureClass: classification.failureClass,
          confidence: classification.confidence,
          evidenceLine: classification.evidenceLine,
        },
      });
    }
    return row.id;
  });

  if (inserted === null) {
    // Lost a race with an identical request: answer from what the winner stored.
    const winner = await existingRun(ctx, cycle.id, tool.id, result.attempt);
    if (!winner) throw new Error('run insert conflicted but no run exists');
    return winner;
  }
  return {
    runId: inserted,
    created: true,
    classification: classification ? toPayload(classification) : null,
  };
}

async function classifyRun(ctx: Ctx, input: ClassifyInput): Promise<Classification> {
  const { deps } = ctx;
  const rules = classify(input);
  if (rules) return rules;
  if (deps.llm === null || input.run.outcome !== 'FAIL') return unknownClassification(input);
  const llm = new GuardedLlm({
    db: ctx.db,
    inner: deps.llm,
    purpose: 'classify',
    budget: deps.config.groqDailyTokenBudget,
    maxCalls: CLASSIFY_MAX_CALLS,
    now: deps.now,
    model: deps.config.compilerModel ?? resolveConfig().model,
  });
  return classifyWithFallback(input, { llm });
}

/** Every reported log path must be EXACTLY the path /internal/uploads would have handed out for that step. */
function validatedLogPaths(ctx: Ctx, body: RunBody): Map<string, string> {
  const r = body.runResult;
  const byId = new Map(r.steps.map((s) => [s.stepId, s]));
  const out = new Map<string, string>();
  for (const [stepId, path] of Object.entries(body.logPaths)) {
    const step = byId.get(stepId);
    if (
      !step ||
      !SAFE_STEP_ID.test(stepId) ||
      path !== logPathFor(ctx.deps.config.ingestHmacSecret, r.cycleId, r.toolSlug, r.attempt, step)
    )
      throw new HttpError(
        400,
        'Bad Request',
        `The log path for step "${stepId.slice(0, 64)}" does not belong to this run.`,
      );
    out.set(stepId, path);
  }
  return out;
}

/**
 * The stored run as the API answers it, rebuilt from the stored rows and never from the retried request.
 * The evidence line is not stored, so it is recomputed from the stored tails (rules are deterministic).
 */
async function existingRun(
  ctx: Ctx,
  cycleId: string,
  toolId: string,
  attempt: number,
): Promise<RunResponse | null> {
  const [row] = await ctx.db
    .select()
    .from(runs)
    .where(and(eq(runs.cycleId, cycleId), eq(runs.toolId, toolId), eq(runs.attempt, attempt)));
  if (!row) return null;
  if (row.failureClass === null || row.failureSignature === null)
    return { runId: row.id, created: false, classification: null };

  const [tool] = await ctx.db.select().from(tools).where(eq(tools.id, toolId));
  const target = Target.parse((tool as { config: unknown }).config);
  const storedSteps = await ctx.db.select().from(stepResults).where(eq(stepResults.runId, row.id));
  const steps: StepResult[] = storedSteps
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((s) => ({
      stepId: s.stepId,
      ordinal: s.ordinal,
      kind: s.kind,
      outcome: s.outcome as StepResult['outcome'],
      exitCode: s.exitCode,
      durationMs: s.durationMs,
      stdoutTail: s.stdoutTail,
      stderrTail: s.stderrTail,
      logFile: s.logPath,
      matchedAuthPattern: null,
      skipReason: s.kind === 'manual' && row.skipReason === 'manual_step' ? 'manual_step' : null,
    }));
  const failed = steps.find((s) => s.stepId === row.failedStepId);
  const input = inputFromRunResult(
    {
      toolSlug: target.slug,
      cycleId,
      attempt,
      planId: null,
      snapshotHash: null,
      outcome: row.outcome,
      reachedLevel: row.reachedLevel,
      failedStepId: row.failedStepId,
      steps,
      imageDigest: row.imageDigest,
      runnerEnv: {},
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt.toISOString(),
    },
    {
      language: target.language,
      targetLevel: target.level,
      authErrorIsPass: failed?.kind === 'run' && target.expect.authErrorIsPass && target.level >= 3,
    },
  );
  const again = input ? classify(input) : null;
  return {
    runId: row.id,
    created: false,
    classification: {
      failureClass: row.failureClass,
      ruleId: row.classifierRule ?? 'none',
      signature: row.failureSignature,
      evidenceLine: again && again.ruleId === row.classifierRule ? again.evidenceLine : null,
      source: sourceOf(row.classifierRule),
    },
  };
}
