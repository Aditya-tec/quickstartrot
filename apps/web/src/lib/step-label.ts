import type { SafeRun } from '@qsr/core/public';

// The label of a step on a run page. Most steps come from the compiled plan; the harness adds a few of its own
// (the checks that prove level 2), which are not in the plan.

export type PlanStep = NonNullable<SafeRun['plan_ir']>['steps'][number];

const HARNESS_CHECKS: Record<string, string> = {
  'qsr-check-syntax': 'Check: the code parses',
  'qsr-check-imports': 'Check: its imports resolve',
};

export function describeStep(
  row: { step_id: string; kind: string },
  step: PlanStep | undefined,
): { what: string; code: string | null } {
  if (step) {
    switch (step.kind) {
      case 'shell':
        return { what: 'Shell command', code: step.command };
      case 'run':
        return { what: 'Run the snippet', code: step.command };
      case 'write_file':
        return { what: 'Write file', code: step.path };
      case 'append_file':
        return { what: 'Append to file', code: step.path };
      case 'set_env':
        return { what: 'Set a dummy environment variable', code: step.name };
      case 'manual':
        return { what: 'Needs a person', code: step.reason };
    }
  }
  if (row.kind === 'harness_check')
    return { what: HARNESS_CHECKS[row.step_id] ?? 'Harness check', code: null };
  return { what: 'Step', code: null };
}
