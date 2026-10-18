import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StepResult } from '@qsr/core';
import { evaluateExpect } from './expect.js';
import { shadowL3FromStep } from './shadow-l3.js';
import { StepOutput } from './sink.js';

// What each vendor REALLY answered to a dummy key (qsr run in Docker, one request each, 2026-10-18), saved as fixtures. Every L3 and
// shadow-L3 target has one, and the evidence rule must read it the way we claim: an auth pattern from the spec or a registered vendor
// pattern, no drift error beside it. A vendor pattern may only be added from output like this.

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', 'fixtures', 'l3-observed');

interface Observed {
  slug: string;
  vendor: string;
  exitCode: number;
  expect: { pass: boolean; matchedAuthPattern: string };
  log: string;
}
const fixtures: Observed[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as Observed);

const asStep = (o: Observed, evidence: ReturnType<StepOutput['finish']>): StepResult => ({
  stepId: 's9',
  ordinal: 9,
  kind: 'run',
  outcome: 'PASS',
  exitCode: o.exitCode,
  durationMs: 1000,
  stdoutTail: null,
  stderrTail: evidence.stderrTail,
  logFile: null,
  matchedAuthPattern: o.expect.matchedAuthPattern,
  skipReason: null,
  shadowExportCheck: null,
});

describe('the real answers of vendors to a dummy key', () => {
  it('there is a fixture for every L3 and shadow-L3 target we run (and nothing else sneaks in)', () => {
    expect(fixtures.map((f) => f.slug)).toEqual([
      'anthropic-python',
      'cerebras-python',
      'openrouter-node',
      'resend-python',
    ]);
  });

  it.each(fixtures)(
    '$slug ($vendor): the evidence rule finds the evidence it is claimed to',
    (o) => {
      const out = new StepOutput({ secrets: ['qsr_dummy_key'], stdoutIncludes: [] });
      out.stderr(`${o.log}\n`);
      const done = out.finish();
      const verdict = evaluateExpect(
        { exitCode: 0, authErrorIsPass: true, stdoutIncludes: [], timeoutSec: 300 },
        { exitCode: o.exitCode, timedOut: false, ...done.evidence },
      );
      expect(verdict.pass).toBe(true);
      expect(verdict.matchedAuthPattern).toBe(o.expect.matchedAuthPattern);
      expect(done.evidence.driftPattern).toBeNull(); // no import error beside it
    },
  );

  it.each(fixtures)(
    '$slug: the shadow record says "evidence" and observes a real line of the answer',
    (o) => {
      const out = new StepOutput({ secrets: ['qsr_dummy_key'], stdoutIncludes: [] });
      out.stderr(`${o.log}\n`);
      const done = out.finish();
      const record = shadowL3FromStep(asStep(o, done), done.evidence);
      expect(record.verdict).toBe('evidence');
      expect(record.pattern).toBe(o.expect.matchedAuthPattern);
      expect(record.observed?.length ?? 0).toBeGreaterThan(5);
      expect(record.observed?.length ?? 0).toBeLessThanOrEqual(300);
    },
  );
});
