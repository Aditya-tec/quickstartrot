import type { FailureClass, RunOutcome, SkipReason } from '@qsr/core';

/** The step that failed (or the manual step a run stopped at), as the classifier reads it. */
export interface FailingStep {
  id: string;
  /** `shell`, `run`, `write_file`, `harness_check`, `manual`, ... */
  kind: string;
  /** The plan's command for this step, when known (shown to the LLM fallback, never matched on). */
  command: string | null;
  exitCode: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  /** The full redacted step log when available; the tails are used when it is not. */
  log: string | null;
}

/** What the rules may know about the run besides the failing step. */
export interface RunContext {
  language: 'node' | 'python';
  targetLevel: number;
  reachedLevel: number;
  /** The run's outcome: FAIL, SKIPPED or HARNESS_ERROR (a PASS is never classified). */
  outcome: RunOutcome;
  skipReason: SkipReason | null;
  /** Whether the failing step treats an auth error as a pass. When true, an auth error is never the cause. */
  authErrorIsPass: boolean;
}

export interface ClassifyInput {
  step: FailingStep | null;
  run: RunContext;
}

export type ClassificationSource = 'rule' | 'llm' | 'none';

export interface Classification {
  failureClass: FailureClass;
  /** Stable id of the rule that matched; `llm.fallback` for an accepted LLM answer; `none` otherwise. */
  ruleId: string;
  /** The log line (or fact) that justified the class. */
  evidenceLine: string | null;
  /** sha256(class + stepKind + normalize(firstErrorLines)): stable across paths, line numbers, timestamps. */
  signature: string;
  source: ClassificationSource;
  /** Set for LLM answers (listed in the admin queue so a rule can be added). */
  confidence: number | null;
}
