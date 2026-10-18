import { OPERATOR_IDS, OPERATOR_INFO, type OperatorId } from './operators.js';
import type { ControlRecord, MutantRecord } from './run.js';

// The numbers of a mutation run. Rates are over mutants that really ran and gave a verdict (detected or survived);
// `invalid`, `not_applicable` and `harness_error` are counted and shown but never averaged in. Detection is reported per
// level and per operator, never only as one number: the levels are the point.

export interface Rate {
  detected: number;
  survived: number;
  /** detected + survived. */
  tested: number;
  /** detected / tested, or null when nothing was tested. */
  detection: number | null;
  /** Detected mutants that had a fixed expectation, and how many of them got the expected class. */
  classified: number;
  classCorrect: number;
  classification: number | null;
}

export function rateOf(rows: readonly MutantRecord[]): Rate {
  const detected = rows.filter((r) => r.status === 'detected');
  const survived = rows.filter((r) => r.status === 'survived');
  const classified = detected.filter((r) => r.classMatches !== null);
  const correct = classified.filter((r) => r.classMatches === true);
  const tested = detected.length + survived.length;
  return {
    detected: detected.length,
    survived: survived.length,
    tested,
    detection: tested === 0 ? null : detected.length / tested,
    classified: classified.length,
    classCorrect: correct.length,
    classification: classified.length === 0 ? null : correct.length / classified.length,
  };
}

export interface Counts {
  invalid: number;
  notApplicable: number;
  harnessError: number;
}
export const countsOf = (rows: readonly MutantRecord[]): Counts => ({
  invalid: rows.filter((r) => r.status === 'invalid').length,
  notApplicable: rows.filter((r) => r.status === 'not_applicable').length,
  harnessError: rows.filter((r) => r.status === 'harness_error').length,
});

/**
 * Install-level mutants (a package typo, a version pin) are stopped by the package manager at L1, whatever the harness checks do.
 * Code-level mutants (a symbol, a method, a deep path, syntax, an option) are what the harness checks are for. They are reported
 * apart and never averaged: a blended rate would credit the monitor for what npm and pip do anyway.
 */
export type Kind = 'install' | 'code';
export const KINDS: readonly Kind[] = ['install', 'code'];
export const OPERATOR_KIND: Record<OperatorId, Kind | null> = {
  pkg_typo: 'install',
  version_pin: 'install',
  renamed_symbol: 'code',
  renamed_method: 'code',
  deep_import: 'code',
  syntax_error: 'code',
  option_misnamed: 'code',
  previous_major: null,
};

/** One cell of the install/code by level table: the rate, the mutants left out, and how many targets stand behind it. */
export type Cell = Rate & Counts & { targets: number };
export type KindLevel = Record<Kind, Record<'L1' | 'L2' | 'L3', Cell>>;

const LEVEL_KEYS = ['L1', 'L2', 'L3'] as const;

export function cellOf(rows: readonly MutantRecord[]): Cell {
  const rate = rateOf(rows);
  return {
    ...rate,
    ...countsOf(rows),
    targets: new Set(
      rows.filter((r) => r.status === 'detected' || r.status === 'survived').map((r) => r.slug),
    ).size,
  };
}

export function kindLevelOf(mutants: readonly MutantRecord[]): KindLevel {
  const mutation = only(mutants, 'mutation');
  const cells = (kind: Kind): Record<'L1' | 'L2' | 'L3', Cell> =>
    Object.fromEntries(
      LEVELS.map((level) => [
        `L${level}`,
        cellOf(mutation.filter((m) => OPERATOR_KIND[m.operator] === kind && m.level === level)),
      ]),
    ) as Record<'L1' | 'L2' | 'L3', Cell>;
  return { install: cells('install'), code: cells('code') };
}

export interface SurvivorPattern {
  operator: OperatorId;
  level: number;
  reason: string;
  count: number;
  targets: string[];
}

export interface Summary {
  controls: { total: number; included: number; excluded: { slug: string; reason: string }[] };
  /** Install-level and code-level mutants by level. There is deliberately no blended overall rate. */
  byKind: KindLevel;
  /** Mutants with no site, per kind: the plan had nothing for that operator to change. */
  noSite: Record<Kind, number>;
  /** Included targets by the level their control reached. */
  levelTargets: Record<'L1' | 'L2' | 'L3', number>;
  byOperator: Record<string, Rate & Counts>;
  byLevel: Record<string, Rate & Counts & { targets: number }>;
  byOperatorLevel: Record<string, Record<string, Rate>>;
  experiment: (Rate & Counts) | null;
  survivorPatterns: SurvivorPattern[];
}

const LEVELS = [1, 2, 3] as const;
const only = (rows: readonly MutantRecord[], group: 'mutation' | 'experiment'): MutantRecord[] =>
  rows.filter((r) => r.group === group);

export function summarize(
  controls: readonly ControlRecord[],
  mutants: readonly MutantRecord[],
): Summary {
  const mutation = only(mutants, 'mutation');
  const experiment = only(mutants, 'experiment');
  const byOperator: Summary['byOperator'] = {};
  for (const id of OPERATOR_IDS) {
    if (OPERATOR_INFO[id].group !== 'mutation') continue;
    const rows = mutation.filter((m) => m.operator === id);
    byOperator[id] = { ...rateOf(rows), ...countsOf(rows) };
  }
  const byLevel: Summary['byLevel'] = {};
  for (const level of LEVELS) {
    const rows = mutation.filter((m) => m.level === level);
    byLevel[`L${level}`] = {
      ...rateOf(rows),
      ...countsOf(rows),
      targets: controls.filter((c) => c.included && c.reachedLevel === level).length,
    };
  }
  const byOperatorLevel: Summary['byOperatorLevel'] = {};
  for (const id of OPERATOR_IDS) {
    if (OPERATOR_INFO[id].group !== 'mutation') continue;
    byOperatorLevel[id] = {};
    for (const level of LEVELS)
      byOperatorLevel[id][`L${level}`] = rateOf(
        mutation.filter((m) => m.operator === id && m.level === level),
      );
  }

  const patterns = new Map<string, SurvivorPattern>();
  for (const m of mutation.filter((x) => x.status === 'survived')) {
    const key = `${m.operator}|${m.level}|${m.survivorReason}`;
    const p = patterns.get(key) ?? {
      operator: m.operator,
      level: m.level,
      reason: m.survivorReason ?? '',
      count: 0,
      targets: [],
    };
    p.count += 1;
    p.targets.push(m.slug);
    patterns.set(key, p);
  }
  return {
    controls: {
      total: controls.length,
      included: controls.filter((c) => c.included).length,
      excluded: controls
        .filter((c) => !c.included)
        .map((c) => ({ slug: c.slug, reason: c.excludedReason ?? '' })),
    },
    byKind: kindLevelOf(mutants),
    noSite: {
      install: mutation.filter(
        (m) => OPERATOR_KIND[m.operator] === 'install' && m.status === 'not_applicable',
      ).length,
      code: mutation.filter(
        (m) => OPERATOR_KIND[m.operator] === 'code' && m.status === 'not_applicable',
      ).length,
    },
    levelTargets: Object.fromEntries(
      LEVEL_KEYS.map((l) => [
        l,
        controls.filter((c) => c.included && `L${c.reachedLevel}` === l).length,
      ]),
    ) as Record<'L1' | 'L2' | 'L3', number>,
    byOperator,
    byLevel,
    byOperatorLevel,
    experiment: experiment.length === 0 ? null : { ...rateOf(experiment), ...countsOf(experiment) },
    survivorPatterns: [...patterns.values()].sort(
      (a, b) => b.count - a.count || (a.operator < b.operator ? -1 : 1),
    ),
  };
}

/** Mutants that detected with a class other than the expected one, for the classification table. */
export const misclassified = (mutants: readonly MutantRecord[]): MutantRecord[] =>
  mutants.filter((m) => m.status === 'detected' && m.classMatches === false);

// ---------------------------------------------------------------- before / after the export check

export interface Comparison {
  /** Controls that passed before and FAILED with the check on: false positives, the number that matters most. */
  falsePositives: { slug: string; reason: string }[];
  /** Mutant keys (slug:operator) that survived before and were detected after. */
  newlyDetected: string[];
  before: Rate;
  after: Rate;
  byLevelBefore: Record<string, Rate>;
  byLevelAfter: Record<string, Rate>;
  byOperatorBefore: Record<string, Rate>;
  byOperatorAfter: Record<string, Rate>;
  byKindBefore: KindLevel;
  byKindAfter: KindLevel;
}

/**
 * `after` holds the controls and the re-run survivors of the run with the check on; every other mutant was already
 * detected before, and a detected mutant stays detected (the check only ever adds a failure).
 */
export function compareRuns(
  before: { controls: readonly ControlRecord[]; mutants: readonly MutantRecord[] },
  after: { controls: readonly ControlRecord[]; mutants: readonly MutantRecord[] },
): Comparison {
  const key = (m: MutantRecord): string => `${m.slug}:${m.operator}`;
  const rerun = new Map(after.mutants.map((m) => [key(m), m]));
  const merged = before.mutants.map((m) =>
    m.status === 'survived' && rerun.has(key(m)) ? (rerun.get(key(m)) as MutantRecord) : m,
  );
  const beforeM = only(before.mutants, 'mutation');
  const afterM = only(merged, 'mutation');
  const beforeControls = new Map(before.controls.map((c) => [c.slug, c]));
  const levelRates = (rows: readonly MutantRecord[]): Record<string, Rate> =>
    Object.fromEntries(LEVELS.map((l) => [`L${l}`, rateOf(rows.filter((m) => m.level === l))]));
  const opRates = (rows: readonly MutantRecord[]): Record<string, Rate> =>
    Object.fromEntries(
      OPERATOR_IDS.filter((id) => OPERATOR_INFO[id].group === 'mutation').map((id) => [
        id,
        rateOf(rows.filter((m) => m.operator === id)),
      ]),
    );
  return {
    falsePositives: after.controls
      .filter((c) => beforeControls.get(c.slug)?.included === true && !c.included)
      .map((c) => ({ slug: c.slug, reason: c.excludedReason ?? '' })),
    newlyDetected: beforeM
      .filter((m) => m.status === 'survived' && rerun.get(key(m))?.status === 'detected')
      .map(key),
    before: rateOf(beforeM),
    after: rateOf(afterM),
    byLevelBefore: levelRates(beforeM),
    byLevelAfter: levelRates(afterM),
    byOperatorBefore: opRates(beforeM),
    byOperatorAfter: opRates(afterM),
    byKindBefore: kindLevelOf(beforeM),
    byKindAfter: kindLevelOf(afterM),
  };
}

// ---------------------------------------------------------------- the same mutants under two harness versions

export interface HarnessComparison {
  before: KindLevel;
  after: KindLevel;
  /** slug:operator that survived before and is detected now. */
  newlyDetected: string[];
  /** slug:operator that was detected before and survives now: a regression, to be explained. */
  newlyMissed: string[];
}

/** Both runs use the same seed and the same mutants, so the verdicts are compared one by one. */
export function compareHarnessRuns(
  before: { controls: readonly ControlRecord[]; mutants: readonly MutantRecord[] },
  after: { controls: readonly ControlRecord[]; mutants: readonly MutantRecord[] },
): HarnessComparison {
  const key = (m: MutantRecord): string => `${m.slug}:${m.operator}`;
  const was = new Map(before.mutants.map((m) => [key(m), m.status]));
  const now = new Map(after.mutants.map((m) => [key(m), m.status]));
  const keys = [...new Set([...was.keys(), ...now.keys()])].sort();
  return {
    before: kindLevelOf(before.mutants),
    after: kindLevelOf(after.mutants),
    newlyDetected: keys.filter((k) => was.get(k) === 'survived' && now.get(k) === 'detected'),
    newlyMissed: keys.filter((k) => was.get(k) === 'detected' && now.get(k) === 'survived'),
  };
}
