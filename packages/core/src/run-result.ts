import { z } from 'zod';
import { RunOutcome, StepOutcome } from './taxonomy.js';

// Spec section 9: the executor's output contract. The executor does not classify failures.
export const TAIL_MAX_BYTES = 4096; // stdout/stderr tails kept in the database
export const STEP_LOG_MAX_BYTES = 256 * 1024; // full redacted step log, before gzip

/** Keys the executor writes into `runnerEnv` (spec sections 9 and 10). All values are strings. */
export const RUNNER_ENV_KEYS = {
  /** JSON object {"package": "version"} of top-level dependencies after the last install step. */
  resolved: 'resolved',
} as const;

/** Reads `runnerEnv.resolved` back into a map; an absent or malformed value is an empty map. */
export function parseResolved(runnerEnv: Readonly<Record<string, string>>): Record<string, string> {
  const raw = runnerEnv[RUNNER_ENV_KEYS.resolved];
  if (raw === undefined) return {};
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

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
  // Flat string record, exactly as in spec section 9. The version-drift capture of section 10
  // ("runner_env.resolved") is stored inside it as a JSON string: see RUNNER_ENV_KEYS.resolved.
  runnerEnv: z.record(z.string(), z.string()),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
export type RunResult = z.infer<typeof RunResult>;
