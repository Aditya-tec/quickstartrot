import { describe, expect, it } from 'vitest';
import { OPERATOR_IDS, type OperatorId } from './operators.js';
import type { ControlRecord, MutantRecord, MutantStatus } from './run.js';
import { OPERATOR_KIND, compareHarnessRuns, summarize } from './stats.js';

// P9d: the headline is never one blended number. Install-level mutants (a typo, a version pin) are reported apart from code-level
// ones (symbol, method, deep path, syntax, option), each by level, with the count tested, the targets behind it and the mutants
// that had no site. Install-level mutants are caught by the package manager at L1 whatever the harness checks do, so averaging them
// with code-level ones would flatter the monitor.

const control = (slug: string, level: number): ControlRecord => ({
  slug,
  included: true,
  excludedReason: null,
  outcome: 'PASS',
  reachedLevel: level,
  targetLevel: 3,
  retried: false,
  durationMs: 1,
  resolved: {},
  hasRunStep: level === 3,
  writesSource: true,
});

const mutant = (
  slug: string,
  operator: OperatorId,
  level: number,
  status: MutantStatus,
): MutantRecord => ({
  slug,
  operator,
  group: operator === 'previous_major' ? 'experiment' : 'mutation',
  status,
  level,
  change: null,
  expected: null,
  outcome: null,
  reachedLevel: null,
  failedStepId: null,
  failedStepKind: null,
  failureClass: null,
  ruleId: null,
  evidence: null,
  classMatches: null,
  survivorReason: status === 'survived' ? 'because' : null,
  note: status === 'not_applicable' ? 'the plan has no site for this operator' : null,
  durationMs: null,
  exportsCheck: false,
});

describe('OPERATOR_KIND', () => {
  it('puts the two install-level operators apart from the five code-level ones, and the experiment in neither', () => {
    expect(
      OPERATOR_IDS.filter((id) => OPERATOR_KIND[id] === 'install')
        .sort()
        .join(),
    ).toBe('pkg_typo,version_pin');
    expect(
      OPERATOR_IDS.filter((id) => OPERATOR_KIND[id] === 'code')
        .sort()
        .join(),
    ).toBe('deep_import,option_misnamed,renamed_method,renamed_symbol,syntax_error');
    expect(OPERATOR_KIND.previous_major).toBeNull();
  });
});

describe('summarize: install-level and code-level are reported apart, by level', () => {
  const controls = [control('a', 2), control('b', 2), control('c', 3), control('d', 1)];
  const mutants = [
    mutant('a', 'pkg_typo', 2, 'detected'),
    mutant('b', 'pkg_typo', 2, 'detected'),
    mutant('c', 'version_pin', 3, 'detected'),
    mutant('d', 'pkg_typo', 1, 'detected'),
    mutant('a', 'renamed_symbol', 2, 'survived'),
    mutant('b', 'renamed_symbol', 2, 'detected'),
    mutant('a', 'syntax_error', 2, 'detected'),
    mutant('c', 'renamed_method', 3, 'survived'),
    mutant('c', 'syntax_error', 3, 'detected'),
    mutant('b', 'deep_import', 2, 'not_applicable'),
    mutant('d', 'renamed_symbol', 1, 'not_applicable'),
    mutant('d', 'option_misnamed', 1, 'not_applicable'),
    mutant('a', 'previous_major', 2, 'detected'),
  ];
  const s = summarize(controls, mutants);

  it('counts install-level mutants by level with their targets', () => {
    expect(s.byKind.install.L2).toMatchObject({ detected: 2, tested: 2, targets: 2 });
    expect(s.byKind.install.L3).toMatchObject({ detected: 1, tested: 1, targets: 1 });
    expect(s.byKind.install.L1).toMatchObject({ detected: 1, tested: 1, targets: 1 });
  });

  it('counts code-level mutants by level, with the targets that had a tested mutant, and does not blend them with install', () => {
    expect(s.byKind.code.L2).toMatchObject({ detected: 2, survived: 1, tested: 3, targets: 2 });
    expect(s.byKind.code.L3).toMatchObject({ detected: 1, survived: 1, tested: 2, targets: 1 });
    expect(s.byKind.code.L1).toMatchObject({ tested: 0, detection: null, targets: 0 });
  });

  it('counts mutants with no site and the targets at each level separately from the tested ones', () => {
    expect(s.byKind.code.L2.notApplicable).toBe(1);
    expect(s.byKind.code.L1.notApplicable).toBe(2);
    expect(s.noSite).toEqual({ install: 0, code: 3 });
    expect(s.levelTargets).toEqual({ L1: 1, L2: 2, L3: 1 });
  });

  it('has no blended overall rate at all, and leaves the experiment out of both kinds', () => {
    expect(s).not.toHaveProperty('mutation');
    const tested = (['install', 'code'] as const).flatMap((k) =>
      (['L1', 'L2', 'L3'] as const).map((l) => s.byKind[k][l].tested),
    );
    expect(tested.reduce((n, x) => n + x, 0)).toBe(9); // the 13 minus 3 with no site, minus the experiment
  });
});

describe('compareHarnessRuns: the same mutants under two harness versions', () => {
  const controls = [control('a', 2), control('b', 2)];
  const v1 = [
    mutant('a', 'syntax_error', 2, 'survived'),
    mutant('b', 'syntax_error', 2, 'detected'),
    mutant('a', 'deep_import', 2, 'survived'),
    mutant('b', 'deep_import', 2, 'survived'),
  ];
  const v2 = [
    mutant('a', 'syntax_error', 2, 'detected'),
    mutant('b', 'syntax_error', 2, 'detected'),
    mutant('a', 'deep_import', 2, 'survived'),
    mutant('b', 'deep_import', 2, 'detected'),
  ];
  const c = compareHarnessRuns({ controls, mutants: v1 }, { controls, mutants: v2 });

  it('lists what v2 newly detects and anything it newly misses', () => {
    expect(c.newlyDetected.sort()).toEqual(['a:syntax_error', 'b:deep_import']);
    expect(c.newlyMissed).toEqual([]);
  });

  it('gives the code-level rate by level for both sides', () => {
    expect(c.before.code.L2).toMatchObject({ detected: 1, tested: 4 });
    expect(c.after.code.L2).toMatchObject({ detected: 3, tested: 4 });
    expect(c.before.install.L2.tested).toBe(0);
  });

  it('says a mutant that was detected before and survives now is newly missed', () => {
    const worse = compareHarnessRuns({ controls, mutants: v2 }, { controls, mutants: v1 });
    expect(worse.newlyMissed.sort()).toEqual(['a:syntax_error', 'b:deep_import']);
    expect(worse.newlyDetected).toEqual([]);
  });
});
