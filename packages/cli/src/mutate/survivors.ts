import type { StepIR } from '@qsr/core';
import type { OperatorId } from './operators.js';

// Why the monitor could not see a mutant that PASSED. Every reason is built from facts about the plan that ran (does it
// run the snippet, which level did it reach) and from what the harness checks actually do, so it is never empty and never
// a guess dressed up as a fact. The wording is meant to be quoted.

export interface SurvivorFacts {
  operator: OperatorId;
  language: StepIR['language'];
  /** The level the UNMUTATED plan reached (1 install, 2 build, 3 reached the vendor). */
  controlLevel: number;
  /** Whether the plan runs the snippet (a `run` step). */
  runsSnippet: boolean;
  /** Whether the plan writes a source file the L2 checks look at. */
  writesSource: boolean;
  /** Whether the experimental export check was on for this run. */
  exportsCheck: boolean;
}

const NODE_L2 =
  'The L2 checks parse the file (`node --check`, or TypeScript syntax diagnostics) and resolve each import specifier from node_modules; they do not load the package, so they cannot see which names it exports.';
const PY_L2 =
  'The L2 checks compile the file (`py_compile`) and look up the top-level module of each import; they do not import the package, so they cannot see which names it provides.';

export function survivorReason(f: SurvivorFacts): string {
  const l2 = f.language === 'node' ? NODE_L2 : PY_L2;
  const notRun = `The plan never runs the snippet (the run reaches L${f.controlLevel}). `;
  switch (f.operator) {
    case 'pkg_typo':
    case 'version_pin':
      return 'The package manager accepted the altered install argument, so the install step passed: the name or version exists in the registry (a squatted name, or a pin the manager resolved). This is not a gap in the checks.';
    case 'renamed_symbol':
      if (!f.writesSource)
        return `The plan writes no source file, so there was nothing to check or run. Only the install is tested (L${f.controlLevel}).`;
      return f.runsSnippet
        ? 'The snippet ran and still passed. A destructured require of a missing name gives undefined and fails only if the value is used on the executed path; an import of a missing name normally fails at once, so check this one by hand.'
        : `${notRun}${l2} A name the package no longer exports is invisible until the code runs.`;
    case 'renamed_method':
      if (!f.writesSource)
        return `The plan writes no source file, so there was nothing to check or run. Only the install is tested (L${f.controlLevel}).`;
      return f.runsSnippet
        ? 'The snippet ran and still passed: the renamed call was not reached on the executed path (a dummy key ends the run at the first authenticated call, which counts as a pass), or the SDK tolerated the missing method.'
        : `${notRun}${l2} A method the object no longer has is only found when it is called.`;
    case 'deep_import':
      if (!f.writesSource)
        return `The plan writes no source file, so there was nothing to check or run. Only the install is tested (L${f.controlLevel}).`;
      return f.language === 'python'
        ? `${PY_L2} A sub-module path that does not exist is only found when the module is imported, and the plan does not run the snippet.`
        : 'The import check resolved the altered specifier (the package offers that path, or the file was resolved by the CommonJS fallback), and the plan did not run the snippet.';
    case 'syntax_error':
      return f.writesSource
        ? f.language === 'node'
          ? 'The syntax check passed although a bracket or quote was removed. Either (1) the file is a .js file that uses import where no package.json says type module: node --check then exits 0 WITHOUT parsing the file (found by this run and reproduced in the sandbox image), so a broken ES-module .js file passes; or (2) the edit landed inside a string or template literal, which the parser accepts.'
          : 'The syntax check passed although a bracket or quote was removed: the edit landed inside a string or docstring, which the parser accepts.'
        : 'The plan writes no source file the syntax check parses, so the edit was never parsed.';
    case 'option_misnamed':
      if (!f.writesSource)
        return `The plan writes no source file, so there was nothing to check or run. Only the install is tested (L${f.controlLevel}).`;
      return f.runsSnippet
        ? 'The snippet ran and still passed: the vendor SDK ignores an option it does not know, or the run ended with an authentication error before options were validated (an auth error counts as a pass).'
        : `${notRun}${l2} An option name is only meaningful to the vendor's code at call time.`;
    case 'previous_major':
      return 'The previous major version installed without error and the checks (and the run, if the plan has one) still passed: the snippet works with both majors, or the part of the API the snippet touches did not change.';
  }
}
