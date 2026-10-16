import { z } from 'zod';
import { RunOutcome, StepOutcome } from './taxonomy.js';

// Spec section 9: the executor's output contract. The executor does not classify failures.
export const TAIL_MAX_BYTES = 4096; // stdout/stderr tails kept in the database
export const STEP_LOG_MAX_BYTES = 256 * 1024; // full redacted step log, before gzip

export const StepResult = z.object({
  stepId: z.string(),
  ordinal: z.number().int().min(0),
  kind: z.string(),
  outcome: StepOutcome,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
  stdoutTail: z.string().max(TAIL_MAX_BYTES).nullable(),
  stderrTail: z.string().max(TAIL_MAX_BYTES).nullable(),
  logFile: z.string().nullable(), // relative path of the redacted log in the results dir
  matchedAuthPattern: z.string().nullable().default(null), // L3 auth-error-as-pass evidence
});
export type StepResult = z.infer<typeof StepResult>;

export const RunResult = z.object({
  toolSlug: z.string(),
  cycleId: z.uuid(),
  attempt: z.number().int().min(1),
  planId: z.uuid().nullable(),
  snapshotHash: z.string().nullable(),
  outcome: RunOutcome,
  reachedLevel: z.number().int().min(0).max(4),
  failedStepId: z.string().nullable(),
  steps: z.array(StepResult),
  imageDigest: z.string(),
  runnerEnv: z.record(z.string(), z.string()),
  // Spec section 10 "Version drift capture": resolved top-level versions, stored by the API as
  // runner_env.resolved. Kept separate here because runnerEnv is a flat string record.
  resolved: z.record(z.string(), z.string()).default({}),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
export type RunResult = z.infer<typeof RunResult>;
