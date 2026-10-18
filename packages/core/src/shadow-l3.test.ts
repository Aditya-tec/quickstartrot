import { describe, expect, it } from 'vitest';
import {
  compileConfigHash,
  L3ShadowReportResponse,
  ShadowL3,
  SHADOW_L3_VERDICTS,
  StepResult,
  Target,
  type TargetInput,
} from './index.js';

// Shadow-L3 (harness v3 follow-up): a target can run its L3 step in SHADOW. The step runs once per cycle, its result is stored, and it has
// no effect on level, status, incidents, badges or public pages. The flag is per target and needs a written reason.

const base: TargetInput = {
  slug: 'acme-node',
  name: 'Acme',
  docsUrl: 'https://example.com/docs',
  language: 'node',
  level: 3,
  runtime: { image: 'ghcr.io/me/qsr-node:22', nodeVersion: '22' },
  extract: { root: 'main' },
  placeholders: { YOUR_API_KEY: 'qsr_dummy_key' },
  expect: { authErrorIsPass: true, timeoutSec: 300 },
};
const REASON = 'New L3 step: observed for a week of cycles before it may count';

describe('Target: l3 shadow mode', () => {
  it('is optional and stays absent when absent', () => {
    expect('l3' in Target.parse(base)).toBe(false);
  });

  it('needs mode "shadow" and a written reason of at least 10 characters', () => {
    const ok = Target.parse({ ...base, l3: { mode: 'shadow', reason: REASON } });
    expect(ok.l3).toEqual({ mode: 'shadow', reason: REASON });
    for (const bad of [
      { mode: 'shadow' },
      { mode: 'shadow', reason: 'short' },
      { mode: 'shadow', reason: 'x'.repeat(301) },
      { mode: 'on', reason: REASON },
      { reason: REASON },
      { mode: 'shadow', reason: REASON, extra: 1 },
    ])
      expect(Target.safeParse({ ...base, l3: bad }).success, JSON.stringify(bad)).toBe(false);
  });

  it('is not part of the plan cache key: promoting a target out of shadow recompiles nothing', () => {
    expect(
      compileConfigHash(Target.parse({ ...base, l3: { mode: 'shadow', reason: REASON } })),
    ).toBe(compileConfigHash(Target.parse(base)));
  });
});

describe('ShadowL3 (what a shadow L3 step recorded)', () => {
  const rec = {
    verdict: 'evidence' as const,
    pattern: 'http_401_403',
    exitCode: 1,
    observed: 'AuthenticationError: 401 {"type":"error"}',
    durationMs: 812,
    note: null,
  };

  it('has a closed set of verdicts', () => {
    expect([...SHADOW_L3_VERDICTS].sort()).toEqual(
      ['error_no_evidence', 'evidence', 'no_evidence', 'skipped', 'timeout', 'vetoed'].sort(),
    );
    for (const verdict of SHADOW_L3_VERDICTS)
      expect(ShadowL3.safeParse({ ...rec, verdict }).success).toBe(true);
    expect(ShadowL3.safeParse({ ...rec, verdict: 'maybe' }).success).toBe(false);
  });

  it('bounds what it stores: the observed text and the note are short', () => {
    expect(ShadowL3.safeParse({ ...rec, observed: 'x'.repeat(301) }).success).toBe(false);
    expect(ShadowL3.safeParse({ ...rec, note: 'x'.repeat(301) }).success).toBe(false);
    expect(ShadowL3.safeParse({ ...rec, durationMs: -1 }).success).toBe(false);
  });

  it('rides on a step result, optional, and a result without it still parses', () => {
    const step = {
      stepId: 'qsr-check-imports',
      ordinal: 3,
      kind: 'harness_check',
      outcome: 'PASS' as const,
      exitCode: 0,
      durationMs: 5,
      stdoutTail: null,
      stderrTail: null,
      logFile: null,
    };
    expect(StepResult.parse(step).shadowL3).toBeUndefined();
    expect(StepResult.parse({ ...step, shadowL3: rec }).shadowL3).toEqual(rec);
    expect(StepResult.parse({ ...step, shadowL3: null }).shadowL3).toBeNull();
  });
});

describe('L3ShadowReportResponse', () => {
  it('parses a report with per-target counts, observed texts and a promotion verdict', () => {
    const r = L3ShadowReportResponse.parse({
      generatedAt: '2026-10-25T12:00:00.000Z',
      days: 7,
      since: '2026-10-18T12:00:00.000Z',
      tools: [
        {
          slug: 'acme-node',
          reason: 'New L3 step',
          cycles: 9,
          withRecord: 9,
          verdicts: { evidence: 9 },
          patterns: [{ pattern: 'http_401_403', cycles: 9 }],
          observed: [{ text: 'AuthenticationError: 401', cycles: 9 }],
          ambiguous: 0,
          lastAt: '2026-10-25T06:17:00.000Z',
          promotion: { ready: true, cleanCycles: 9, blockers: [] },
        },
      ],
    });
    expect(r.tools[0]?.promotion.ready).toBe(true);
  });
});
