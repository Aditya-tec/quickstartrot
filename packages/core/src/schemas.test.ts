import { describe, expect, it } from 'vitest';
import {
  Extraction,
  FAILURE_CLASSES,
  INITIAL_TOOL_STATE,
  parseResolved,
  PASSES_TO_RECOVER,
  RECURRENCE_WINDOW_DAYS,
  RUNNER_ENV_KEYS,
  RunResult,
  runSkipReason,
  SKIP_REASONS,
  StatusEvent,
  StepIR,
  Target,
  ToolState,
  TRANSIENT_INCIDENT_STREAK,
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

  it('has an optional enabled flag: absent stays absent (so existing config hashes do not change), false is kept', () => {
    expect('enabled' in Target.parse(validTarget)).toBe(false);
    expect(Target.parse({ ...validTarget, enabled: false }).enabled).toBe(false);
    expect(Target.parse({ ...validTarget, enabled: true }).enabled).toBe(true);
    expect(Target.safeParse({ ...validTarget, enabled: 'no' }).success).toBe(false);
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

  it('parses and defaults matchedAuthPattern and skipReason', () => {
    const r = RunResult.parse(run);
    expect(r.steps[0]?.matchedAuthPattern).toBeNull();
    expect(r.steps[0]?.skipReason).toBeNull();
  });

  it('carries why a step was skipped on the STEP, so the spec section 9 run shape is unchanged', () => {
    expect(SKIP_REASONS).toEqual(['manual_step']);
    const step = { ...run.steps[0], stepId: 's2', kind: 'manual', outcome: 'SKIPPED' };
    const skipped = RunResult.parse({
      ...run,
      outcome: 'SKIPPED',
      steps: [run.steps[0], { ...step, skipReason: 'manual_step' }],
    });
    expect(skipped.steps[1]?.skipReason).toBe('manual_step');
    expect(runSkipReason(skipped)).toBe('manual_step');
    expect(runSkipReason(RunResult.parse(run))).toBeNull();
    expect(
      RunResult.safeParse({ ...run, steps: [{ ...run.steps[0], skipReason: 'tired' }] }).success,
    ).toBe(false);
  });

  it('is the spec section 9 shape plus harnessVersion (P9d, requested by the owner): no other top-level keys, runnerEnv is a flat string record', () => {
    expect(Object.keys(RunResult.shape).sort()).toEqual(
      [
        'toolSlug',
        'cycleId',
        'attempt',
        'planId',
        'snapshotHash',
        'outcome',
        'reachedLevel',
        'failedStepId',
        'steps',
        'imageDigest',
        'runnerEnv',
        'startedAt',
        'finishedAt',
        'harnessVersion',
      ].sort(),
    );
    expect(
      RunResult.safeParse({ ...run, runnerEnv: { node: 'v22', nested: { a: 1 } } }).success,
    ).toBe(false);
  });

  it('carries resolved versions in runnerEnv as a JSON string and reads them back', () => {
    const env = {
      node: 'v22.0.0',
      [RUNNER_ENV_KEYS.resolved]: JSON.stringify({ resend: '4.0.1' }),
    };
    expect(RunResult.safeParse({ ...run, runnerEnv: env }).success).toBe(true);
    expect(parseResolved(env)).toEqual({ resend: '4.0.1' });
    expect(parseResolved({ node: 'v22' })).toEqual({});
    expect(parseResolved({ resolved: 'not json' })).toEqual({});
    expect(parseResolved({ resolved: '{"a": 1}' })).toEqual({});
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

describe('status engine types', () => {
  it('INITIAL_TOOL_STATE is a valid ToolState and a fresh tool is UNKNOWN', () => {
    expect(ToolState.parse(INITIAL_TOOL_STATE)).toEqual(INITIAL_TOOL_STATE);
    expect(INITIAL_TOOL_STATE.status).toBe('UNKNOWN');
  });

  it('ToolState rejects negative streaks and unknown statuses', () => {
    expect(ToolState.safeParse({ ...INITIAL_TOOL_STATE, consecutiveFailures: -1 }).success).toBe(
      false,
    );
    expect(ToolState.safeParse({ ...INITIAL_TOOL_STATE, status: 'GREAT' }).success).toBe(false);
  });

  it('the spec numbers are constants: 7 days, 4 transient in a row, 2 passes', () => {
    expect([RECURRENCE_WINDOW_DAYS, TRANSIENT_INCIDENT_STREAK, PASSES_TO_RECOVER]).toEqual([
      7, 4, 2,
    ]);
  });

  it('every event type parses and unknown ones do not', () => {
    const events = [
      {
        type: 'incident_opened',
        failureClass: 'API_DRIFT',
        signature: 's',
        trigger: 'repeat_failure',
      },
      { type: 'incident_resolved', incidentId: 'i' },
      {
        type: 'incident_signature_changed',
        incidentId: 'i',
        from: 'a',
        to: 'b',
        failureClass: 'API_DRIFT',
      },
      { type: 'incident_recurred', incidentId: 'i', signature: 's', failureClass: 'API_DRIFT' },
      { type: 'admin_queue', reason: 'skipped', failureClass: null, signature: null, detail: 'd' },
      { type: 'cycle_ignored', note: 'n' },
    ];
    for (const e of events) expect(StatusEvent.safeParse(e).success, e.type).toBe(true);
    expect(StatusEvent.safeParse({ type: 'incident_deleted' }).success).toBe(false);
    expect(
      StatusEvent.safeParse({
        type: 'admin_queue',
        reason: 'because',
        failureClass: null,
        signature: null,
        detail: '',
      }).success,
    ).toBe(false);
  });
});

describe('Target extract.variants', () => {
  const variants = { splitOn: ['//\s*ESM', '//\s*(?:CommonJs|CJS)'], prefer: 'ESM' };
  const withVariants = (v: unknown) => ({
    ...validTarget,
    extract: { ...validTarget.extract, variants: v },
  });

  it('is optional and absent by default', () => {
    expect(Target.parse(validTarget).extract.variants).toBeUndefined();
  });

  it('parses splitOn regexes and a preferred variant', () => {
    expect(Target.parse(withVariants(variants)).extract.variants).toEqual(variants);
  });

  it.each([
    ['no markers', { splitOn: [], prefer: 'ESM' }],
    ['an empty preference', { splitOn: ['//\s*ESM'], prefer: '' }],
    ['a marker that is not a valid regex', { splitOn: ['//(ESM'], prefer: 'ESM' }],
    ['a preference that is not a valid regex', { splitOn: ['//\s*ESM'], prefer: '(ESM' }],
    ['an empty marker pattern', { splitOn: [''], prefer: 'ESM' }],
    ['an unknown key', { splitOn: ['//\s*ESM'], prefer: 'ESM', extra: 1 }],
  ])('rejects %s', (_name, v) => {
    expect(Target.safeParse(withVariants(v)).success).toBe(false);
  });
});

describe('Extraction.variants (what the crawler chose)', () => {
  const base = {
    url: 'https://example.com/a',
    finalUrl: 'https://example.com/a',
    title: 'Quickstart',
    fetchedAt: '2026-10-16T00:00:00Z',
    blocks: [],
    contentHash: 'abc',
  };

  it('is optional', () => {
    expect(Extraction.parse(base).variants).toBeUndefined();
  });

  it('records the preference and, per affected block, what was kept and which markers were removed', () => {
    const report = {
      prefer: 'ESM',
      blocks: [
        {
          originalIndex: 8,
          blockIndex: 7,
          action: 'kept_variant',
          keptMarker: '// ESM',
          markers: ['// ESM', '// CommonJs'],
        },
        {
          originalIndex: 20,
          blockIndex: null,
          action: 'dropped_block',
          keptMarker: null,
          markers: ['// CommonJs'],
        },
      ],
    };
    expect(Extraction.parse({ ...base, variants: report }).variants).toEqual(report);
  });

  it('rejects an unknown action', () => {
    const report = {
      prefer: 'ESM',
      blocks: [
        { originalIndex: 1, blockIndex: 1, action: 'merged', keptMarker: null, markers: [] },
      ],
    };
    expect(Extraction.safeParse({ ...base, variants: report }).success).toBe(false);
  });
});
