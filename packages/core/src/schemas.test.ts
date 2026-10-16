import { describe, expect, it } from 'vitest';
import {
  Extraction,
  FAILURE_CLASSES,
  RunResult,
  StepIR,
  Target,
  type TargetInput,
  TAIL_MAX_BYTES,
} from './index.js';

const validTarget: TargetInput = {
  slug: 'resend-node',
  name: 'Resend (Node.js SDK)',
  docsUrl: 'https://example.com/docs/quickstart/nodejs',
  language: 'node',
  level: 3,
  runtime: { image: 'ghcr.io/me/qsr-node:22', nodeVersion: '22' },
  extract: { root: 'main article', tab: 'Node.js', ignoreBlocksMatching: ['^// Output:'] },
  placeholders: { YOUR_API_KEY: 'qsr_dummy_key' },
  expect: { authErrorIsPass: true, timeoutSec: 300 },
  owners: { x: '@vendor', github: 'vendor/docs-repo' },
  notes: 'Quickstart sends one email via the SDK.',
};

describe('Target', () => {
  it('parses the spec example and applies defaults', () => {
    const t = Target.parse(validTarget);
    expect(t.extract.codeBlocks).toBe('pre code');
    expect(Target.parse({ ...validTarget, expect: undefined }).expect).toEqual({
      authErrorIsPass: false,
      timeoutSec: 300,
    });
  });

  it.each(['Resend', 'resend_node', '-x', 'x-', 'a--b', ''])('rejects slug %j', (slug) => {
    expect(Target.safeParse({ ...validTarget, slug }).success).toBe(false);
  });

  it('rejects non-http docs URLs, bad levels and unknown languages', () => {
    expect(Target.safeParse({ ...validTarget, docsUrl: 'file:///etc/passwd' }).success).toBe(false);
    expect(Target.safeParse({ ...validTarget, level: 5 }).success).toBe(false);
    expect(Target.safeParse({ ...validTarget, level: 0 }).success).toBe(false);
    expect(Target.safeParse({ ...validTarget, language: 'go' }).success).toBe(false);
  });
});

describe('Extraction', () => {
  it('parses a minimal extraction', () => {
    const e = Extraction.parse({
      url: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      title: 'Quickstart',
      fetchedAt: '2026-10-16T00:00:00Z',
      blocks: [
        {
          index: 0,
          kind: 'code',
          lang: 'ts',
          text: 'npm i x',
          filenameHint: null,
          headingPath: ['Quickstart'],
        },
      ],
      contentHash: 'abc',
    });
    expect(e.blocks).toHaveLength(1);
  });

  it('rejects a block with an unknown kind', () => {
    expect(
      Extraction.safeParse({
        url: 'https://example.com/a',
        finalUrl: 'https://example.com/a',
        title: 't',
        fetchedAt: '2026-10-16T00:00:00Z',
        blocks: [
          { index: 0, kind: 'image', lang: null, text: '', filenameHint: null, headingPath: [] },
        ],
        contentHash: 'x',
      }).success,
    ).toBe(false);
  });
});

const src = { blockIndex: 0, lineStart: 0, lineEnd: 0 };
const shell = {
  kind: 'shell' as const,
  id: 's1',
  command: 'npm install resend',
  source: src,
  expect: {},
};

describe('StepIR', () => {
  const ir = {
    irVersion: 1,
    language: 'node',
    projectInit: 'npm_init',
    steps: [shell],
    maxLevelReachable: 3,
    notes: '',
  };

  it('parses and fills Expect defaults', () => {
    const parsed = StepIR.parse(ir);
    const step = parsed.steps[0];
    expect(step?.kind).toBe('shell');
    if (step?.kind === 'shell') {
      expect(step.expect).toEqual({
        exitCode: 0,
        authErrorIsPass: false,
        stdoutIncludes: [],
        timeoutSec: 180,
      });
    }
  });

  it('accepts a run step and a set_env step without a source', () => {
    const parsed = StepIR.safeParse({
      ...ir,
      steps: [
        shell,
        { kind: 'set_env', id: 'e1', name: 'KEY', value: 'qsr_dummy_key', source: null },
        { kind: 'run', id: 'r1', command: 'node index.js', source: null, expect: {} },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a shell step without a source, empty plans and plans over 30 steps', () => {
    expect(
      StepIR.safeParse({ ...ir, steps: [{ kind: 'shell', id: 's', command: 'x', expect: {} }] })
        .success,
    ).toBe(false);
    expect(StepIR.safeParse({ ...ir, steps: [] }).success).toBe(false);
    expect(
      StepIR.safeParse({
        ...ir,
        steps: Array.from({ length: 31 }, (_, i) => ({ ...shell, id: `s${i}` })),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown step kinds and a timeout above 600s', () => {
    expect(StepIR.safeParse({ ...ir, steps: [{ kind: 'eval', id: 'x' }] }).success).toBe(false);
    expect(
      StepIR.safeParse({ ...ir, steps: [{ ...shell, expect: { timeoutSec: 601 } }] }).success,
    ).toBe(false);
  });
});

describe('RunResult', () => {
  const run = {
    toolSlug: 'resend-node',
    cycleId: '3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60',
    attempt: 1,
    planId: null,
    snapshotHash: null,
    outcome: 'PASS',
    reachedLevel: 3,
    failedStepId: null,
    steps: [
      {
        stepId: 's1',
        ordinal: 0,
        kind: 'shell',
        outcome: 'PASS',
        exitCode: 0,
        durationMs: 1200,
        stdoutTail: 'ok',
        stderrTail: null,
        logFile: 'resend-node-1/s1.log',
      },
    ],
    imageDigest: 'sha256:abc',
    runnerEnv: { node: 'v22.0.0' },
    startedAt: '2026-10-16T00:00:00Z',
    finishedAt: '2026-10-16T00:01:00Z',
  };

  it('parses and defaults matchedAuthPattern and resolved', () => {
    const r = RunResult.parse(run);
    expect(r.steps[0]?.matchedAuthPattern).toBeNull();
    expect(r.resolved).toEqual({});
  });

  it('rejects oversized tails, bad uuid and out-of-range level', () => {
    const big = 'x'.repeat(TAIL_MAX_BYTES + 1);
    expect(
      RunResult.safeParse({ ...run, steps: [{ ...run.steps[0], stdoutTail: big }] }).success,
    ).toBe(false);
    expect(RunResult.safeParse({ ...run, cycleId: 'nope' }).success).toBe(false);
    expect(RunResult.safeParse({ ...run, reachedLevel: 5 }).success).toBe(false);
  });
});

describe('taxonomy', () => {
  it('has the 11 failure classes from the spec', () => {
    expect(FAILURE_CLASSES).toHaveLength(11);
  });
});
