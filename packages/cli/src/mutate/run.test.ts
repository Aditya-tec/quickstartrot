import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunResult, StepIR } from '@qsr/core';
import { cjsInput, esmInput, installOnlyInput, pythonInput } from './fixtures.test-utils.js';
import type { MutationInput } from './inputs.js';
import { OPERATOR_IDS, type OperatorId } from './operators.js';
import {
  notRunRecord,
  prepareMutant,
  runControl,
  runMutation,
  type ControlRecord,
  type PlanRunner,
  type RunnerArgs,
  type RunnerOutput,
} from './run.js';
import { compareRuns, misclassified, rateOf, summarize } from './stats.js';
import { survivorReason } from './survivors.js';

// The engine is tested with a fake runner that answers like the sandbox would, and the REAL classifier and grounding
// validator. No Docker, no network.

const NOW = '2026-10-18T00:00:00.000Z';

function result(
  args: RunnerArgs,
  over: {
    outcome: RunResult['outcome'];
    failedStepId?: string;
    kind?: string;
    stderr?: string;
    reached?: number;
    resolved?: Record<string, string>;
  },
): RunnerOutput {
  const failed = over.failedStepId ?? null;
  const steps = args.ir.steps.map((s, i) => ({
    stepId: s.id,
    ordinal: i,
    kind: s.kind,
    outcome: (s.id === failed ? 'FAIL' : 'PASS') as 'FAIL' | 'PASS',
    exitCode: s.id === failed ? 1 : 0,
    durationMs: 1000,
    stdoutTail: '',
    stderrTail: s.id === failed ? (over.stderr ?? '') : '',
    logFile: null,
    matchedAuthPattern: null,
    skipReason: null,
  }));
  return {
    result: {
      toolSlug: args.input.target.slug,
      cycleId: randomUUID(),
      attempt: 1,
      planId: null,
      snapshotHash: null,
      outcome: over.outcome,
      reachedLevel: over.reached ?? (over.outcome === 'PASS' ? args.input.ir.maxLevelReachable : 1),
      failedStepId: failed,
      steps,
      harnessVersion: 2,
      imageDigest: 'sha256:' + 'a'.repeat(64),
      runnerEnv: {
        hostPlatform: 'test',
        resolved: JSON.stringify(
          over.resolved ?? { 'acme-sdk': '6.3.0', '@scope/acme-sdk': '6.3.0' },
        ),
      },
      startedAt: NOW,
      finishedAt: NOW,
    },
    logs: {},
  };
}

const E404 =
  'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/acmeqq-sdk - Not found';
const NO_EXPORT =
  "SyntaxError: The requested module 'acme-sdk' does not provide an export named 'AcmeQsr'";

/** A sandbox that behaves like the real monitor: installs fail on bad names, the L2 checks see syntax, runs see exports. */
const monitor =
  (calls: RunnerArgs[] = []): PlanRunner =>
  async (a) => {
    calls.push(a);
    const install = a.ir.steps.find((s) => s.kind === 'shell');
    if (install?.kind === 'shell' && /qq|999\.999/.test(install.command))
      return result(a, { outcome: 'FAIL', failedStepId: install.id, kind: 'shell', stderr: E404 });
    const file = a.ir.steps.find((s) => s.kind === 'write_file');
    if (
      file?.kind === 'write_file' &&
      /AcmeQsr/.test(file.content) &&
      a.ir.steps.some((s) => s.kind === 'run')
    )
      return result(a, { outcome: 'FAIL', failedStepId: 's3', kind: 'run', stderr: NO_EXPORT });
    return result(a, { outcome: 'PASS' });
  };

/** Mutants that gave a verdict, summed over the install-level and code-level cells (there is no blended rate to read it from). */
const testedIn = (s: ReturnType<typeof summarize>): number =>
  (['install', 'code'] as const).reduce(
    (n, k) => n + s.byKind[k].L1.tested + s.byKind[k].L2.tested + s.byKind[k].L3.tested,
    0,
  );

describe('controls', () => {
  it('a control that passes is included', async () => {
    const c = await runControl(monitor(), esmInput(), false);
    expect(c).toMatchObject({
      slug: 'esm-node',
      included: true,
      outcome: 'PASS',
      retried: false,
      reachedLevel: 2,
      excludedReason: null,
    });
    expect(c.resolved).toEqual({ 'acme-sdk': '6.3.0', '@scope/acme-sdk': '6.3.0' });
  });

  it('a control that fails once is retried, and passes on the retry', async () => {
    let n = 0;
    const flaky: PlanRunner = async (a) =>
      n++ === 0
        ? result(a, { outcome: 'FAIL', failedStepId: 's1', stderr: 'npm error code ETIMEDOUT' })
        : result(a, { outcome: 'PASS' });
    const c = await runControl(flaky, esmInput(), false);
    expect(c.included).toBe(true);
    expect(c.retried).toBe(true);
  });

  it('a control that fails twice is excluded with the reason, and its mutants are never run', async () => {
    const calls: RunnerArgs[] = [];
    const broken: PlanRunner = async (a) => {
      calls.push(a);
      return result(a, { outcome: 'FAIL', failedStepId: 's1', stderr: E404 });
    };
    const run = await runMutation(broken, [esmInput()], {
      operators: [...OPERATOR_IDS],
      seed: 's',
      concurrency: 2,
      exportsCheck: false,
    });
    expect(run.controls[0]).toMatchObject({ included: false });
    expect(run.controls[0]?.excludedReason).toMatch(
      /did not pass twice: FAIL at s1 \(DEPENDENCY_RESOLUTION, dependency.npm_e404\)/,
    );
    expect(run.mutants).toEqual([]);
    expect(calls.map((c) => c.label)).toEqual(['control', 'control-retry']);
    const s = summarize(run.controls, run.mutants);
    expect(s.controls).toMatchObject({ total: 1, included: 0 });
    expect(s.controls.excluded[0]?.slug).toBe('esm-node');
    expect(testedIn(s)).toBe(0); // an excluded target is in no statistic
  });

  it('a skipped control (a person has to act) is excluded too', async () => {
    const skipped: PlanRunner = async (a) => result(a, { outcome: 'SKIPPED' });
    const c = await runControl(skipped, esmInput(), false);
    expect(c.included).toBe(false);
    expect(c.excludedReason).toMatch(/SKIPPED/);
  });

  it('a cached pair that the validator no longer accepts is excluded before anything runs', async () => {
    const input = esmInput();
    const bad: MutationInput = {
      ...input,
      ir: {
        ...input.ir,
        steps: input.ir.steps.map((s) =>
          s.kind === 'shell' ? { ...s, command: 'npm install something-else' } : s,
        ),
      },
    };
    const calls: RunnerArgs[] = [];
    const c = await runControl(monitor(calls), bad, false);
    expect(c.included).toBe(false);
    expect(c.excludedReason).toMatch(/grounding validator/);
    expect(calls).toHaveLength(0);
  });
});

describe('mutants', () => {
  const control = async (input: MutationInput): Promise<ControlRecord> =>
    runControl(monitor(), input, false);

  it('a mutant that fails is detected, classified by the real classifier, and judged against the expected class', async () => {
    const run = await runMutation(monitor(), [esmInput()], {
      operators: ['pkg_typo', 'version_pin'],
      seed: 's',
      concurrency: 2,
      exportsCheck: false,
    });
    const typo = run.mutants.find((m) => m.operator === 'pkg_typo');
    expect(typo).toMatchObject({
      status: 'detected',
      failureClass: 'DEPENDENCY_RESOLUTION',
      ruleId: 'dependency.npm_e404',
      classMatches: true,
      failedStepId: 's1',
      failedStepKind: 'shell',
      level: 2,
    });
  });

  it('a runtime export error at a run step is API_DRIFT; the same mutant on a plan with no run step survives', async () => {
    const withRun = await runMutation(monitor(), [cjsInput()], {
      operators: ['renamed_symbol'],
      seed: 's',
      concurrency: 1,
      exportsCheck: false,
    });
    expect(withRun.mutants[0]).toMatchObject({
      status: 'detected',
      failureClass: 'API_DRIFT',
      ruleId: 'drift.no_export',
      classMatches: true,
      level: 3,
    });
    const noRun = await runMutation(monitor(), [esmInput()], {
      operators: ['renamed_symbol'],
      seed: 's',
      concurrency: 1,
      exportsCheck: false,
    });
    expect(noRun.mutants[0]?.status).toBe('survived');
    expect(noRun.mutants[0]?.survivorReason).toMatch(/never runs the snippet/);
  });

  it('a detection with an unexpected class is flagged as a mismatch', async () => {
    const wrongClass: PlanRunner = async (a) => {
      const w = a.ir.steps.find((s) => s.kind === 'write_file');
      if (a.label !== 'control' && w?.kind === 'write_file' && /AcmeQsr/.test(w.content))
        return result(a, {
          outcome: 'FAIL',
          failedStepId: w.id,
          stderr: 'SyntaxError: Unexpected token',
        });
      return result(a, { outcome: 'PASS' });
    };
    const run = await runMutation(wrongClass, [esmInput()], {
      operators: ['renamed_symbol'],
      seed: 's',
      concurrency: 1,
      exportsCheck: false,
    });
    const m = run.mutants[0];
    expect(m).toMatchObject({
      status: 'detected',
      failureClass: 'DOCS_SNIPPET_ERROR',
      classMatches: false,
    });
    expect(misclassified(run.mutants)).toHaveLength(1);
  });

  it('an operator with no fixed expectation records what happened and has no class verdict', async () => {
    const run = await runMutation(monitor(), [cjsInput()], {
      operators: ['option_misnamed'],
      seed: 's',
      concurrency: 1,
      exportsCheck: false,
    });
    expect(run.mutants[0]?.expected).toBeNull();
    expect(run.mutants[0]?.classMatches).toBeNull();
  });

  it('a plan with no site for an operator is not applicable', async () => {
    const run = await runMutation(monitor(), [installOnlyInput()], {
      operators: [...OPERATOR_IDS],
      seed: 's',
      concurrency: 2,
      exportsCheck: false,
    });
    const byOp = Object.fromEntries(run.mutants.map((m) => [m.operator, m.status]));
    expect(byOp['renamed_symbol']).toBe('not_applicable');
    expect(byOp['pkg_typo']).toBe('detected');
    expect(byOp['previous_major']).toBe('survived'); // monitor() passes an @5 install
  });

  it('a mutant the real validator refuses is invalid and is never run', async () => {
    // the plan quotes the docs with a placeholder already replaced by its dummy value, but the placeholder is a name the
    // operator renames: docs and plan can no longer agree, and the validator says so
    const input = esmInput();
    const tricky: MutationInput = {
      ...input,
      target: { ...input.target, placeholders: { Acme: 'Zed', YOUR_API_KEY: 'qsr_dummy_key' } },
      ir: {
        ...input.ir,
        steps: input.ir.steps.map((s) =>
          s.kind === 'write_file' ? { ...s, content: s.content.replaceAll('Acme', 'Zed') } : s,
        ),
      },
    };
    const calls: RunnerArgs[] = [];
    const ctl = await runControl(monitor(calls), tricky, false);
    expect(ctl.included).toBe(true);
    const job = prepareMutant(tricky, ctl, 'renamed_symbol', 'a', false);
    if (job.record.change?.startsWith('Acme ->')) {
      expect(job.record.status).toBe('invalid');
      expect(job.record.note).toMatch(/real grounding validator refused/);
      expect(job.run).toBeNull();
    }
    const before = calls.length;
    await runMutation(monitor(calls), [tricky], {
      operators: ['renamed_symbol'],
      seed: 'a',
      concurrency: 1,
      exportsCheck: false,
    });
    expect(calls.length - before).toBeGreaterThanOrEqual(1); // only the control, unless the seed picked another binding
  });

  it('the harness failing is not a verdict: it is left out of the rates', async () => {
    const flaky: PlanRunner = async (a) =>
      a.label === 'pkg_typo'
        ? result(a, { outcome: 'HARNESS_ERROR' })
        : result(a, { outcome: 'PASS' });
    const run = await runMutation(flaky, [esmInput()], {
      operators: ['pkg_typo'],
      seed: 's',
      concurrency: 1,
      exportsCheck: false,
    });
    expect(run.mutants[0]?.status).toBe('harness_error');
    const s = summarize(run.controls, run.mutants);
    expect(testedIn(s)).toBe(0);
    expect(s.byKind.install.L2).toMatchObject({ tested: 0, harnessError: 1, detection: null });
  });

  describe('a failure of the environment is not a detection (found in the P9d v2 run: a DNS blip counted as "detected")', () => {
    const DNS =
      'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/acme-sdk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org';
    const options = {
      operators: ['pkg_typo' as const],
      seed: 's',
      concurrency: 1,
      exportsCheck: false,
    };
    const firstShell = (a: RunnerArgs): string =>
      a.ir.steps.find((s) => s.kind === 'shell')?.id ?? 's1';

    it('a network failure is run once more, and the second answer is the verdict', async () => {
      let seen = 0;
      const blip: PlanRunner = async (a) => {
        if (a.label !== 'pkg_typo' && a.label !== 'pkg_typo-retry')
          return result(a, { outcome: 'PASS' });
        seen += 1;
        return seen === 1
          ? result(a, { outcome: 'FAIL', failedStepId: firstShell(a), stderr: DNS })
          : result(a, { outcome: 'FAIL', failedStepId: firstShell(a), stderr: E404 });
      };
      const run = await runMutation(blip, [esmInput()], options);
      expect(seen).toBe(2);
      expect(run.mutants[0]).toMatchObject({
        status: 'detected',
        failureClass: 'DEPENDENCY_RESOLUTION',
        classMatches: true,
        retried: true,
      });
    });

    it('a second network failure leaves the mutant out of the rates as a harness error, never as a detection', async () => {
      const down: PlanRunner = async (a) =>
        a.label.startsWith('pkg_typo')
          ? result(a, { outcome: 'FAIL', failedStepId: firstShell(a), stderr: DNS })
          : result(a, { outcome: 'PASS' });
      const run = await runMutation(down, [esmInput()], options);
      expect(run.mutants[0]).toMatchObject({ status: 'harness_error', retried: true });
      expect(run.mutants[0]?.note).toMatch(/network|environment/i);
      const s = summarize(run.controls, run.mutants);
      expect(testedIn(s)).toBe(0);
    });

    it('a failure of a class the operator does not expect is also run once more; if it repeats it stays detected and is shown as a mismatch', async () => {
      let n = 0;
      const odd: PlanRunner = async (a) => {
        if (!a.label.startsWith('pkg_typo')) return result(a, { outcome: 'PASS' });
        n += 1;
        return result(a, { outcome: 'FAIL', failedStepId: firstShell(a), stderr: 'something odd' });
      };
      const run = await runMutation(odd, [esmInput()], options);
      expect(n).toBe(2);
      expect(run.mutants[0]).toMatchObject({
        status: 'detected',
        classMatches: false,
        retried: true,
      });
    });

    it('a mutant that fails as expected the first time is not run twice', async () => {
      let n = 0;
      const clean: PlanRunner = async (a) => {
        if (!a.label.startsWith('pkg_typo')) return result(a, { outcome: 'PASS' });
        n += 1;
        return result(a, { outcome: 'FAIL', failedStepId: firstShell(a), stderr: E404 });
      };
      const run = await runMutation(clean, [esmInput()], options);
      expect(n).toBe(1);
      expect(run.mutants[0]).toMatchObject({ status: 'detected', classMatches: true });
      expect(run.mutants[0]?.retried).toBeFalsy();
    });
  });

  it('is deterministic: the same seed gives the same mutants and the same records', async () => {
    const a = await runMutation(monitor(), [esmInput(), cjsInput(), pythonInput()], {
      operators: [...OPERATOR_IDS],
      seed: 'same',
      concurrency: 2,
      exportsCheck: false,
    });
    const b = await runMutation(monitor(), [esmInput(), cjsInput(), pythonInput()], {
      operators: [...OPERATOR_IDS],
      seed: 'same',
      concurrency: 1,
      exportsCheck: false,
    });
    expect(JSON.stringify(a.mutants)).toBe(JSON.stringify(b.mutants));
  });

  it('runs only the named (target, operator) pairs when asked (the survivors of an earlier run)', async () => {
    const run = await runMutation(monitor(), [esmInput()], {
      operators: [...OPERATOR_IDS],
      seed: 's',
      concurrency: 1,
      exportsCheck: false,
      only: new Set(['esm-node:syntax_error']),
    });
    expect(run.mutants.map((m) => m.operator)).toEqual(['syntax_error']);
    expect((await control(esmInput())).included).toBe(true);
  });

  it('never runs more containers at once than the concurrency', async () => {
    let active = 0;
    let max = 0;
    const slow: PlanRunner = async (a) => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return result(a, { outcome: 'PASS' });
    };
    await runMutation(slow, [esmInput(), cjsInput(), pythonInput(), installOnlyInput()], {
      operators: [...OPERATOR_IDS],
      seed: 's',
      concurrency: 2,
      exportsCheck: false,
    });
    expect(max).toBeLessThanOrEqual(2);
    expect(max).toBe(2);
  });
});

describe('mutants that were not run (vendor calls off)', () => {
  it('are counted apart: never tested, never detected, never in a rate', async () => {
    const input = esmInput();
    const control = await runControl(monitor(), input, false);
    const jobs = OPERATOR_IDS.map((op) => notRunRecord(input, control, op, 's'));
    const records = jobs.filter((r): r is NonNullable<typeof r> => r !== null);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.status).toBe('not_run');
      expect(r.outcome).toBeNull();
      expect(r.note).toMatch(/vendor calls are off/);
    }
    const s = summarize([{ ...control, included: false }], records);
    const all = (['install', 'code'] as const).flatMap((k) => [
      s.byKind[k].L1,
      s.byKind[k].L2,
      s.byKind[k].L3,
    ]);
    expect(all.reduce((n, c) => n + c.tested, 0)).toBe(0);
    expect(all.reduce((n, c) => n + c.notRun, 0)).toBeGreaterThan(0);
  });
});

describe('survivor reasons', () => {
  const ops: OperatorId[] = [...OPERATOR_IDS];
  it('every operator, in every plan shape, gets a non-empty reason', () => {
    for (const operator of ops)
      for (const language of ['node', 'python'] as const)
        for (const runsSnippet of [true, false])
          for (const writesSource of [true, false]) {
            const reason = survivorReason({
              operator,
              language,
              controlLevel: 2,
              runsSnippet,
              writesSource,
              exportsCheck: false,
            });
            expect(
              reason.trim().length,
              `${operator} ${language} run=${runsSnippet} src=${writesSource}`,
            ).toBeGreaterThan(40);
          }
  });

  it('the reason for a renamed export at L2 says what the checks do and do not look at', () => {
    const r = survivorReason({
      operator: 'renamed_symbol',
      language: 'node',
      controlLevel: 2,
      runsSnippet: false,
      writesSource: true,
      exportsCheck: false,
    });
    expect(r).toMatch(/never runs the snippet/);
    expect(r).toMatch(/resolve each import specifier/);
    expect(r).toMatch(/cannot see which names/);
  });

  it('the reasons describe harness v2: ES-module .js is parsed now, and a dotted Python import resolves its full path except for packages that build submodules at run time', () => {
    const base = { controlLevel: 2, runsSnippet: false, writesSource: true, exportsCheck: false };
    const syntax = survivorReason({ ...base, operator: 'syntax_error', language: 'node' });
    expect(syntax).not.toMatch(/WITHOUT parsing/);
    expect(syntax).toMatch(/string or template literal/);
    const deep = survivorReason({ ...base, operator: 'deep_import', language: 'python' });
    expect(deep).toMatch(/full dotted path/);
    expect(deep).toMatch(/at run time/);
  });

  it('a surviving mutant record always carries its reason', async () => {
    const passAll: PlanRunner = async (a) => result(a, { outcome: 'PASS' });
    const run = await runMutation(passAll, [esmInput(), cjsInput(), pythonInput()], {
      operators: [...OPERATOR_IDS],
      seed: 's',
      concurrency: 2,
      exportsCheck: false,
    });
    const survivors = run.mutants.filter((m) => m.status === 'survived');
    expect(survivors.length).toBeGreaterThan(5);
    for (const m of survivors)
      expect(m.survivorReason?.length, `${m.slug} ${m.operator}`).toBeGreaterThan(40);
  });
});

describe('statistics', () => {
  it('rates count only mutants that gave a verdict, by operator and by level', async () => {
    const run = await runMutation(monitor(), [esmInput(), cjsInput(), installOnlyInput()], {
      operators: [...OPERATOR_IDS.filter((o) => o !== 'previous_major')],
      seed: 's',
      concurrency: 2,
      exportsCheck: false,
    });
    const s = summarize(run.controls, run.mutants);
    expect(s.controls.included).toBe(3);
    expect(testedIn(s)).toBe(
      Object.values(s.byOperator).reduce((n, r) => n + r.detected + r.survived, 0),
    );
    expect(s.byOperator['pkg_typo']).toMatchObject({ detected: 3, survived: 0, detection: 1 });
    expect(s.byLevel['L3']?.targets).toBe(1);
    expect(s.byLevel['L1']?.targets).toBe(1);
    expect(s.byOperatorLevel['pkg_typo']?.['L2']?.detected).toBe(1);
    expect(s.survivorPatterns.every((p) => p.count >= 1 && p.reason.length > 0)).toBe(true);
    expect(rateOf([])).toMatchObject({ tested: 0, detection: null, classification: null });
  });

  it('compareRuns reports false positives on controls and the survivors the new check caught', async () => {
    const baseline = await runMutation(monitor(), [esmInput(), pythonInput()], {
      operators: ['renamed_symbol'],
      seed: 's',
      concurrency: 2,
      exportsCheck: false,
    });
    expect(baseline.mutants.every((m) => m.status === 'survived')).toBe(true);
    const withCheck: PlanRunner = async (a) => {
      const w = a.ir.steps.find((s) => s.kind === 'write_file');
      if (a.input.target.slug === 'py-python' && a.label.startsWith('control'))
        return result(a, {
          outcome: 'FAIL',
          failedStepId: 's2',
          stderr: 'qsr-check-exports: false positive',
        });
      if (w?.kind === 'write_file' && /Qsr|_qsr/.test(w.content))
        return result(a, { outcome: 'FAIL', failedStepId: 's2', stderr: 'x' });
      return result(a, { outcome: 'PASS' });
    };
    const after = await runMutation(withCheck, [esmInput(), pythonInput()], {
      operators: ['renamed_symbol'],
      seed: 's',
      concurrency: 2,
      exportsCheck: true,
      only: new Set(baseline.mutants.map((m) => `${m.slug}:${m.operator}`)),
    });
    const c = compareRuns(baseline, after);
    expect(c.falsePositives.map((f) => f.slug)).toEqual(['py-python']);
    expect(c.before.detection).toBe(0);
    expect(c.newlyDetected).toEqual(['esm-node:renamed_symbol']); // py-python's control failed, so its mutants did not run
  });
});

export type { StepIR };
