import { isInstallCommand, type Step, type StepIR, type Target, type Truncation } from '@qsr/core';

const NODE_OWN_INIT = /^(npm|pnpm|yarn)\s+init\b/;
const PYTHON_OWN_VENV = /\bvenv\b|\bvirtualenv\b/;

/**
 * Deterministic adjustments applied to the model's plan BEFORE grounding. The model decides order
 * and structure; everything the harness or the target config owns is set here, so the model cannot
 * loosen it:
 *  - expectations: exit code 0, no output assertions (v1 does not assert output), auth-error-as-pass
 *    only for `run` steps of targets that ask for it at level 3+, timeouts capped by the target;
 *  - maxLevelReachable never exceeds the level the target asserts;
 *  - projectInit is the harness setup for the language unless the docs create their own project;
 *  - a plan built from a truncated page claims at most L2 unless what the model could see already
 *    contains an install, a file write and a run step (the part that was left out might hold the rest).
 */
export function finalizePlan(ir: StepIR, target: Target, truncation?: Truncation): StepIR {
  const steps = ir.steps.map((step): Step => {
    if (step.kind !== 'shell' && step.kind !== 'run') return step;
    return {
      ...step,
      expect: {
        exitCode: 0,
        stdoutIncludes: [],
        authErrorIsPass: step.kind === 'run' && target.expect.authErrorIsPass && target.level >= 3,
        timeoutSec: Math.min(step.expect.timeoutSec, target.expect.timeoutSec),
      },
    };
  });

  const ownsProject = steps.some((s) =>
    target.language === 'node'
      ? (s.kind === 'write_file' && s.path.replace(/^\.\//, '') === 'package.json') ||
        (s.kind === 'shell' && NODE_OWN_INIT.test(s.command.trim()))
      : s.kind === 'shell' && PYTHON_OWN_VENV.test(s.command),
  );
  const harnessInit = target.language === 'node' ? 'npm_init' : 'python_venv';

  const incomplete = truncation !== undefined && truncation.truncated;
  const complete =
    steps.some((s) => s.kind === 'shell' && isInstallCommand(s.command)) &&
    steps.some((s) => s.kind === 'write_file' || s.kind === 'append_file') &&
    steps.some((s) => s.kind === 'run');

  return {
    ...ir,
    steps,
    maxLevelReachable: Math.min(
      ir.maxLevelReachable,
      target.level,
      incomplete && !complete ? 2 : 4,
    ),
    projectInit: ownsProject ? 'none' : harnessInit,
  };
}
