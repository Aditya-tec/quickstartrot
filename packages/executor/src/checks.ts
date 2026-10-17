import { toWorkPath, type StepIR } from '@qsr/core';
import { NODE_CHECK_SCRIPT, PYTHON_CHECK_SCRIPT } from './check-scripts.js';
import { isInstallCommand } from './install.js';

export { NODE_CHECK_SCRIPT, PYTHON_CHECK_SCRIPT };

// Harness-owned checks that give level 2 its meaning (spec section 6: "imports, compiles or
// typechecks"). They are not steps of the plan: the executor adds them after the last file is written
// and the last package installed, so nothing the LLM or the docs say can add, remove or alter one.

/** `StepResult.kind` of a check. Not a member of the plan's Step union, so no plan can contain one. */
export const HARNESS_CHECK_KIND = 'harness_check';

export const CHECK_IDS = {
  syntax: 'qsr-check-syntax',
  imports: 'qsr-check-imports',
  /** Experimental, off in every production cycle: see planChecks and docs/DETECTION-POWER.md. */
  exports: 'qsr-check-exports',
} as const;

export const CHECK_TIMEOUT_S = 60;

export const NODE_CHECK_COMMAND: readonly string[] = ['node', '--input-type=module', '-'];
export const PYTHON_CHECK_COMMAND: readonly string[] = ['python', '-'];

export interface HarnessCheck {
  id: string;
  /** The full `docker exec` argv. The files are plain arguments, never parsed by a shell. */
  argv: string[];
  /** The check script, written to the process's stdin. */
  stdin: string;
}

export interface CheckPlan {
  /** Index into `ir.steps` after which the checks run. */
  afterIndex: number;
  checks: HarnessCheck[];
}

const SOURCE_FILE: Record<StepIR['language'], RegExp> = {
  node: /\.(?:[cm]?js|[cm]?ts)$/,
  python: /\.py$/,
};

/** Source files the plan writes that the harness can check, relative to /work, in first-write order. */
export function checkableFiles(ir: StepIR): string[] {
  const out: string[] = [];
  for (const step of ir.steps) {
    if (step.kind !== 'write_file' && step.kind !== 'append_file') continue;
    const p = toWorkPath(step.path);
    if (p.ok && SOURCE_FILE[ir.language].test(p.path) && !out.includes(p.path)) out.push(p.path);
  }
  return out;
}

// `timeout` is the single exec; the marker lets tests and logs tell a check from a plan step.
const CHECK_SHELL = '# qsr-harness-check\nexec timeout -k 5 "$1" "${@:2}"';

/**
 * The checks for a plan, or null when it writes no checkable source file (there is then nothing to
 * prove importable, and level 2 is not claimed). They run after the last file write AND the last
 * install, whichever comes later: imports resolve from what is installed by then.
 */
export function planChecks(ir: StepIR, options: { exports?: boolean } = {}): CheckPlan | null {
  const files = checkableFiles(ir);
  if (files.length === 0) return null;
  let afterIndex = 0;
  for (const [i, step] of ir.steps.entries()) {
    const writes = step.kind === 'write_file' || step.kind === 'append_file';
    if (writes || (step.kind === 'shell' && isInstallCommand(step.command))) afterIndex = i;
  }
  const language = ir.language;
  const script = language === 'node' ? NODE_CHECK_SCRIPT : PYTHON_CHECK_SCRIPT;
  const command = language === 'node' ? NODE_CHECK_COMMAND : PYTHON_CHECK_COMMAND;
  const check = (id: string, mode: 'syntax' | 'imports' | 'exports'): HarnessCheck => ({
    id,
    argv: ['bash', '-lc', CHECK_SHELL, '_', String(CHECK_TIMEOUT_S), ...command, mode, ...files],
    stdin: script,
  });
  return {
    afterIndex,
    // The export check is a feature flag: it loads installed packages (the only check that does) and changes what a level-2
    // pass means, so it is added only when a caller asks for it. No workflow, `qsr execute` or `qsr plan` asks.
    checks: [
      check(CHECK_IDS.syntax, 'syntax'),
      check(CHECK_IDS.imports, 'imports'),
      ...(options.exports === true ? [check(CHECK_IDS.exports, 'exports')] : []),
    ],
  };
}
