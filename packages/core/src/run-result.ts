import { z } from 'zod';
import { RunOutcome, StepOutcome } from './taxonomy.js';

// Spec section 9: the executor's output contract. The executor does not classify failures.
export const TAIL_MAX_BYTES = 4096; // stdout/stderr tails kept in the database
export const STEP_LOG_MAX_BYTES = 256 * 1024; // full redacted step log, before gzip

/** A step id that is safe in a storage path. The report job and the API both check it. */
export const SAFE_STEP_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Keys the executor writes into `runnerEnv` (spec sections 9 and 10). All values are strings. */
export const RUNNER_ENV_KEYS = {
  /** JSON object {"package": "version"} of top-level dependencies after the last install step. */
  resolved: 'resolved',
  /** 'true' when the run used the tool's last accepted plan because the model was not asked. */
  planStale: 'plan_stale',
  /** The probe shard (a number as a string) whose runner executed the plan. */
  shard: 'shard',
  /**
   * Present when the run step passed but L3 was NOT claimed (harness v3): 'no_evidence' (nothing in its output showed a vendor was
   * reached) or 'local' (the target declares that no vendor is involved). Never a failure, never read by the status engine.
   */
  l3: 'l3',
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

/** Why a step (and so the run) was skipped instead of passing or failing. */
export const SKIP_REASONS = ['manual_step'] as const;
export const SkipReason = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReason>;

/**
 * The version of the harness checks that produced a run (P9d). Version 1 is everything recorded before versioning existed (the
 * syntax check could miss a broken ES-module .js file, and the Python imports check looked only at the top-level module);
 * version 2 fixes both. Bump it whenever a harness-owned check changes what it can fail: the status engine never counts failures
 * under different versions as consecutive, so a stricter check cannot turn one old failure plus one new one into an incident.
 */
export const HARNESS_VERSION = 3;

/** The experimental export check run in SHADOW mode: recorded, never acted on (see docs/DETECTION-POWER.md). */
export const SHADOW_OUTCOMES = ['pass', 'fail', 'skipped'] as const;
export const ShadowExportCheck = z.object({
  outcome: z.enum(SHADOW_OUTCOMES),
  /** For a fail: the names the docs import that the loaded package does not have (`pkg: name`), or dotted modules that do not import. */
  missing: z.array(z.string().max(200)).max(50),
  /** Why it was skipped, or a short note on a fail. Never output of the vendor's code. */
  note: z.string().max(300).nullable(),
  durationMs: z.number().int().min(0),
});
export type ShadowExportCheck = z.infer<typeof ShadowExportCheck>;

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
  // Kept on the step, not the run, so RunResult stays exactly the spec section 9 shape.
  skipReason: SkipReason.nullable().default(null),
  // Shadow mode (P9d): present only on the L2 imports-check step the export check follows. It changes nothing else.
  shadowExportCheck: ShadowExportCheck.nullable().optional(),
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
  // Which harness version ran this (P9d). A runner from before versioning sends nothing: that is version 1.
  harnessVersion: z.number().int().min(1).default(1),
  // Flat string record, exactly as in spec section 9. The version-drift capture of section 10
  // ("runner_env.resolved") is stored inside it as a JSON string: see RUNNER_ENV_KEYS.resolved.
  runnerEnv: z.record(z.string(), z.string()),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
export type RunResult = z.infer<typeof RunResult>;

/** The reason a run was skipped (its first skipped step's reason), or null when it was not. */
export function runSkipReason(run: Pick<RunResult, 'steps'>): SkipReason | null {
  return run.steps.find((s) => s.skipReason !== null)?.skipReason ?? null;
}
