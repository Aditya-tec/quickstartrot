import {
  DETECTION_LEVELS,
  type DetectionLevel,
  type DetectionSummary,
} from './detection-summary.js';

// The wording the website and the README quote about the monitor's detection power. One definition, so the two cannot differ, and every
// figure in it is read from the summary (which is derived from docs/detection-power.json). The approved text is "Candidate B" and the
// per-level lines in docs/DETECTION-POWER.md; a test in packages/cli compares this output with that document.
// Rules the wording keeps: install-level and code-level mutants are never added together, level 3 is a number of quickstarts and
// never a rate, and a claim is dropped when the data does not support it.

const noun = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export interface L2Findings {
  /** Quickstarts that had a code-level mutant tested at level 2. */
  targets: number;
  detected: number;
  tested: number;
  /** True when every breakage level 2 noticed was a syntax error or an import path that does not exist. */
  onlySyntaxAndImports: boolean;
  /** Renamed names, renamed methods and misnamed options: they only exist at run time. */
  runtimeDetected: number;
  runtimeTested: number;
}

const RUNTIME_OPERATORS = ['renamed_symbol', 'renamed_method', 'option_misnamed'] as const;

/** What a level 2 pass did and did not see, from the data. */
export function l2Findings(d: DetectionSummary): L2Findings {
  const ops = d.codeL2ByOperator;
  const detectedBy = (op: string): number => ops[op]?.detected ?? 0;
  const testedBy = (op: string): number => ops[op]?.tested ?? 0;
  const c = d.code.L2;
  return {
    targets: c.targets,
    detected: c.detected,
    tested: c.tested,
    onlySyntaxAndImports: detectedBy('syntax_error') + detectedBy('deep_import') === c.detected,
    runtimeDetected: RUNTIME_OPERATORS.reduce((n, op) => n + detectedBy(op), 0),
    runtimeTested: RUNTIME_OPERATORS.reduce((n, op) => n + testedBy(op), 0),
  };
}

/** The sentence about the badge, with the planted-breakage counts that back each clause of it (wording B). */
export function badgeSentence(d: DetectionSummary): string {
  const f = l2Findings(d);
  // the clause "all of them syntax errors and import paths" is only true when nothing else was noticed at level 2
  const first = `In our own tests, planting broken code in ${f.targets} ${noun(f.targets, 'quickstart', 'quickstarts')}, L2 noticed ${f.detected} of ${f.tested} planted breakages${f.onlySyntaxAndImports ? ', all of them syntax errors and import paths that do not exist' : ''}`;
  const second =
    f.runtimeDetected === 0
      ? `it noticed none of the ${f.runtimeTested} renamed names, renamed methods or misnamed options, because those only exist at run time`
      : `it noticed ${f.runtimeDetected} of the ${f.runtimeTested} renamed names, renamed methods or misnamed options, which only exist at run time`;
  return `${first}; ${second}.`;
}

/** Wording B in full: what a green L2 badge means, what the tests found, level 3 as a number of quickstarts, install result apart. */
export function badgeParagraph(d: DetectionSummary): string {
  const n3 = d.l3Targets.length;
  const install = DETECTION_LEVELS.map((l) => d.install[l]);
  const detected = install.reduce((n, c) => n + c.detected, 0);
  const tested = install.reduce((n, c) => n + c.tested, 0);
  return `A green L2 badge means the quickstart installs, parses and its imports resolve. ${badgeSentence(d)} Level 3, where the snippet reaches the vendor, rests on ${n3} ${noun(n3, 'quickstart', 'quickstarts')} so far and we quote no rate for it. (Broken install commands are caught by npm and pip, ${detected} of ${tested}, and say nothing about the code.)`;
}

/** What a pass tells you at each level, for the page that explains the badges. */
export function levelStatements(d: DetectionSummary): Record<DetectionLevel, string> {
  const ops = d.codeL2ByOperator;
  const count = (op: string): string => `${ops[op]?.detected ?? 0} of ${ops[op]?.tested ?? 0}`;
  const n3 = d.l3Targets.length;
  const local = d.levelTargets.local;
  return {
    L1: 'A pass at L1 means the package named in the install command exists and installs on a clean machine today. It does not say the code works.',
    L2: `A pass at L2 means the install works, the code parses, and the packages it imports resolve. It does not mean the names the code uses still exist: at L2 our planted renamed imports were noticed ${count('renamed_symbol')} times, renamed methods ${count('renamed_method')} and misnamed options ${count('option_misnamed')}.`,
    L3: `A pass at L3 means the snippet ran against the vendor's own client library and the vendor's answer, an authentication error for a made-up key, shows it was reached. It does not show the options are right. It rests on ${n3} ${noun(n3, 'quickstart', 'quickstarts')} (${d.l3Targets.join(', ')}), so we quote no detection rate for it.`,
    local: `Some quickstarts are libraries with no service behind them. ${local} ${noun(local, 'target is', 'targets are')} of that kind here. Their snippet runs on our machine and counts as such; it never counts as Level 3.`,
  };
}

/**
 * One sentence about level 3: how many quickstarts reach it in production and how many of them the detection measurement covers. Every
 * figure is read from the summary (the target files and the recorded exclusions); the reason is given only when the data says so.
 */
export function l3ProductionSentence(d: DetectionSummary): string {
  const total = d.l3Production.length;
  if (total === 0) return 'No quickstart reaches L3 in production yet.';
  const covered = d.l3Production.filter((t) => d.l3Targets.includes(t)).length;
  const head = `${total} ${noun(total, 'quickstart reaches', 'quickstarts reach')} L3 in production`;
  if (covered === total) return `${head}, and the detection measurement covers all of them.`;
  const gap = d.l3NotMeasuredVendorCallsOff
    ? ', because vendor calls are off during mutation runs'
    : '';
  return `${head}; the detection measurement covers ${covered} of them${gap}.`;
}
