import type { RunResult } from '@qsr/core';
import type { ClassifyInput } from './types.js';

export interface RunInfo {
  language: 'node' | 'python';
  /** The level the target asserts (from its target file). */
  targetLevel: number;
  /** Whether the failing step treats an auth error as a pass (target `expect.authErrorIsPass`, level 3+, run step). */
  authErrorIsPass: boolean;
  /** Full redacted step logs by step id (`StepResult.logFile` contents), when available. */
  logs?: Readonly<Record<string, string>>;
  /** The plan's commands by step id, when the plan is known. */
  commands?: Readonly<Record<string, string>>;
}

/**
 * What the classifier needs from a RunResult, or null when there is nothing to classify (a PASS).
 * The failing step is the one the run stopped at; for a run skipped at a manual step that is the
 * manual step itself.
 */
export function inputFromRunResult(result: RunResult, info: RunInfo): ClassifyInput | null {
  if (result.outcome === 'PASS') return null;
  const failed = result.steps.find((s) => s.stepId === result.failedStepId);
  return {
    step: failed
      ? {
          id: failed.stepId,
          kind: failed.kind,
          command: info.commands?.[failed.stepId] ?? null,
          exitCode: failed.exitCode,
          stdoutTail: failed.stdoutTail,
          stderrTail: failed.stderrTail,
          log: info.logs?.[failed.stepId] ?? null,
        }
      : null,
    run: {
      language: info.language,
      targetLevel: info.targetLevel,
      reachedLevel: result.reachedLevel,
      outcome: result.outcome,
      skipReason: result.steps.find((s) => s.skipReason !== null)?.skipReason ?? null,
      authErrorIsPass: info.authErrorIsPass,
    },
  };
}
