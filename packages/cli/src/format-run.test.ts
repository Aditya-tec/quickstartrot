import { describe, expect, it } from 'vitest';
import { RUNNER_ENV_KEYS, type RunResult, type StepIR } from '@qsr/core';
import { formatRunResult } from './format-run.js';

const SRC = { blockIndex: 0, lineStart: 1, lineEnd: 1 };
const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
const ir: StepIR = {
  irVersion: 1,
  language: 'node',
  projectInit: 'npm_init',
  maxLevelReachable: 3,
  notes: '',
  steps: [
    {
      kind: 'shell',
      id: 's1',
      command: 'npm install is-number@7.0.0',
      source: SRC,
      expect: EXPECT,
    },
    { kind: 'write_file', id: 's2', path: 'index.js', content: 'x', source: SRC },
    { kind: 'run', id: 's3', command: 'node index.js', source: SRC, expect: EXPECT },
  ],
};
const step = (
  stepId: string,
  ordinal: number,
  kind: string,
  over: Partial<RunResult['steps'][number]> = {},
) => ({
  stepId,
  ordinal,
  kind,
  outcome: 'PASS' as const,
  exitCode: 0,
  durationMs: 1500,
  stdoutTail: null,
  stderrTail: null,
  logFile: null,
  matchedAuthPattern: null,
  skipReason: null,
  shadowExportCheck: null,
  ...over,
});
const base = (over: Partial<RunResult> = {}): RunResult => ({
  toolSlug: 'it-node',
  cycleId: '3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60',
  attempt: 1,
  planId: null,
  snapshotHash: null,
  outcome: 'PASS',
  reachedLevel: 3,
  failedStepId: null,
  steps: [step('s1', 0, 'shell'), step('s2', 1, 'write_file'), step('s3', 2, 'run')],
  harnessVersion: 1,
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runnerEnv: {
    imageSource: 'registry',
    imageRef: 'ghcr.io/o/qsr-node:22',
    node: 'v22.1.0',
    [RUNNER_ENV_KEYS.resolved]: JSON.stringify({ 'is-number': '7.0.0' }),
  },
  startedAt: '2026-10-16T00:00:00.000Z',
  finishedAt: '2026-10-16T00:00:05.000Z',
  ...over,
});
const fmt = (result: RunResult, canary?: Parameters<typeof formatRunResult>[0]['canary']) =>
  formatRunResult({ result, ir, targetLevel: 3, resultFile: '/out/it-node-1.json', canary });

describe('formatRunResult', () => {
  it('shows the verdict, the image, each step with exit code and time, and runner_env', () => {
    const text = fmt(base());
    expect(text).toMatch(/outcome:\s+PASS\s+reached level L3 of the target's L3/);
    expect(text).toContain(
      `image:     sha256:${'a'.repeat(64)}  (registry)  ref: ghcr.io/o/qsr-node:22`,
    );
    expect(text).toMatch(/#0 s1\s+shell\s+npm install is-number@7\.0\.0\s+PASS\s+exit 0\s+1\.5s/);
    expect(text).toMatch(/#1 s2\s+write_file\s+index\.js\s+PASS/);
    expect(text).toMatch(/#2 s3\s+run\s+node index\.js\s+PASS/);
    expect(text).toMatch(/node\s+v22\.1\.0/);
    expect(text).toMatch(/resolved\s+is-number@7\.0\.0/);
    expect(text).toContain('result:    /out/it-node-1.json');
    expect(text).not.toContain('evidence from step');
  });

  it('shows (none) when nothing was resolved', () => {
    expect(fmt(base({ runnerEnv: { imageSource: 'local' } }))).toMatch(/resolved\s+\(none\)/);
  });

  it('for a failure shows the evidence starting at the error line, not just the stack frames', () => {
    const stderr = [
      '/work/index.js:3',
      'nonexistentFunction(5);',
      '^',
      '',
      'TypeError: nonexistentFunction is not a function',
      ...Array.from({ length: 12 }, (_, i) => `    at frame${i} (node:internal/x:${i}:1)`),
      'Node.js v22.1.0',
      '',
    ].join('\n');
    const text = fmt(
      base({
        outcome: 'FAIL',
        reachedLevel: 2,
        failedStepId: 's3',
        steps: [
          step('s1', 0, 'shell'),
          step('s2', 1, 'write_file'),
          step('s3', 2, 'run', {
            outcome: 'FAIL',
            exitCode: 1,
            stderrTail: stderr,
            logFile: 'it-node-1/02-s3.log',
          }),
        ],
      }),
    );
    expect(text).toContain('evidence from step s3 (run)');
    expect(text).toContain('err| TypeError: nonexistentFunction is not a function');
    expect(text).toContain('full log: it-node-1/02-s3.log');
    expect(text.match(/err\| /g)?.length).toBeLessThanOrEqual(10);
  });

  it('falls back to the last lines when nothing looks like an error, and says so when there is no output', () => {
    const quiet = base({
      outcome: 'FAIL',
      failedStepId: 's1',
      steps: [step('s1', 0, 'shell', { outcome: 'FAIL', exitCode: 3, stdoutTail: 'a\nb\nc\n' })],
    });
    expect(fmt(quiet)).toContain('out| c');
    const silent = base({
      outcome: 'FAIL',
      failedStepId: 's1',
      steps: [step('s1', 0, 'shell', { outcome: 'FAIL', exitCode: 3 })],
    });
    expect(fmt(silent)).toContain('(no output)');
  });

  it('for a manual stop says who has to do what, instead of "(no output)"', () => {
    const planWith: StepIR = {
      ...ir,
      steps: [
        {
          kind: 'manual',
          id: 's1',
          reason: 'Needs a person: "npm create hono@latest my-app" is an interactive scaffolder',
          source: SRC,
        },
      ],
    };
    const text = formatRunResult({
      result: base({
        outcome: 'SKIPPED',
        reachedLevel: 0,
        failedStepId: 's1',
        steps: [
          step('s1', 0, 'manual', {
            outcome: 'SKIPPED',
            exitCode: null,
            skipReason: 'manual_step',
          }),
        ],
      }),
      ir: planWith,
      targetLevel: 2,
      resultFile: 'r.json',
    });
    expect(text).toContain(
      'step s1 needs a person: Needs a person: "npm create hono@latest my-app" is an interactive scaffolder',
    );
    expect(text).not.toContain('(no output)');
    expect(text).toMatch(/outcome:\s+SKIPPED\s+reached level L0/);
    expect(text).toContain('skipped: manual_step');
  });

  it('shows the harness checks as their own rows, described in words', () => {
    const text = fmt(
      base({
        steps: [
          step('s1', 0, 'shell'),
          step('s2', 1, 'write_file'),
          step('qsr-check-syntax', 2, 'harness_check'),
          step('qsr-check-imports', 3, 'harness_check'),
          step('s3', 4, 'run'),
        ],
      }),
    );
    expect(text).toMatch(
      /#2 qsr-check-syntax\s+harness_check\s+harness: syntax of written files\s+PASS/,
    );
    expect(text).toMatch(
      /#3 qsr-check-imports\s+harness_check\s+harness: static imports resolve\s+PASS/,
    );
  });

  it('a failed harness check is the evidence, with its own output', () => {
    const text = fmt(
      base({
        outcome: 'FAIL',
        reachedLevel: 1,
        failedStepId: 'qsr-check-imports',
        steps: [
          step('s1', 0, 'shell'),
          step('s2', 1, 'write_file'),
          step('qsr-check-syntax', 2, 'harness_check'),
          step('qsr-check-imports', 3, 'harness_check', {
            outcome: 'FAIL',
            exitCode: 1,
            stderrTail: "index.js:1: Cannot find package 'ghost' imported from index.js\n",
          }),
        ],
      }),
    );
    expect(text).toContain('evidence from step qsr-check-imports (harness_check), redacted:');
    expect(text).toContain("err| index.js:1: Cannot find package 'ghost'");
  });

  it('marks an auth-error pass on the step', () => {
    const text = fmt(
      base({ steps: [step('s3', 2, 'run', { exitCode: 1, matchedAuthPattern: 'http_401_403' })] }),
    );
    expect(text).toMatch(/#2 s3\s+run.*PASS\s+exit 1.*auth:http_401_403/);
  });

  it('reports a canary verdict, matching or not', () => {
    const ok = fmt(base(), { expectedOutcome: 'PASS', verdict: { ok: true, problems: [] } });
    expect(ok).toContain('canary:    OK - expected PASS and got it');
    const bad = fmt(base(), {
      expectedOutcome: 'FAIL',
      verdict: { ok: false, problems: ['expected outcome FAIL but got PASS'] },
    });
    expect(bad).toContain(
      'canary:    MISMATCH - the harness is not behaving: expected outcome FAIL but got PASS',
    );
  });

  it('describes manual, env and unknown steps without crashing', () => {
    const planWith: StepIR = {
      ...ir,
      steps: [
        { kind: 'set_env', id: 'e', name: 'KEY', value: 'v', source: null },
        { kind: 'manual', id: 'm', reason: 'sign up first', source: SRC },
      ],
    };
    const text = formatRunResult({
      result: base({
        steps: [
          step('e', 0, 'set_env'),
          step('m', 1, 'manual', { outcome: 'SKIPPED', exitCode: null }),
          step('ghost', 2, 'shell'),
        ],
      }),
      ir: planWith,
      targetLevel: 3,
      resultFile: 'r.json',
    });
    expect(text).toContain('KEY=...');
    expect(text).toContain('sign up first');
    expect(text).toMatch(/#1 m\s+manual.*SKIPPED\s+exit -/);
  });
});
