import { describe, expect, it } from 'vitest';
import type { RunKind } from '@qsr/core/public';
import { describeDot, summarizeStrip } from './strip.js';
import type { Dot } from './model.js';

const dot = (kind: RunKind, over: Partial<Dot> = {}): Dot => ({
  runId: '00000000-0000-4000-8000-000000000001',
  kind,
  stale: false,
  at: '2026-10-12T14:03:00Z',
  ...over,
});
const many = (kind: RunKind, n: number): Dot[] => Array.from({ length: n }, () => dot(kind));

describe('summarizeStrip: the accessible label of a dot strip', () => {
  it('counts passed and failed, in words', () => {
    expect(summarizeStrip([...many('pass', 26), ...many('fail', 2)])).toBe(
      '28 recent runs: 26 passed, 2 failed',
    );
  });

  it('says "1 recent run" in the singular', () => {
    expect(summarizeStrip(many('pass', 1))).toBe('1 recent run: 1 passed');
  });

  it('leaves out categories that are zero, and names the others', () => {
    expect(
      summarizeStrip([
        ...many('pass', 5),
        ...many('not_run', 2),
        ...many('harness', 1),
        ...many('skipped', 3),
      ]),
    ).toBe('11 recent runs: 5 passed, 2 not run, 1 harness error, 3 skipped');
  });

  it('mentions stale-plan runs, which count as passed or failed but say so', () => {
    expect(summarizeStrip([dot('pass', { stale: true }), dot('pass')])).toBe(
      '2 recent runs: 2 passed, 1 on a stale plan',
    );
  });

  it('is "No runs yet" for an empty strip', () => {
    expect(summarizeStrip([])).toBe('No runs yet');
  });
});

describe('describeDot: the label of one dot', () => {
  it('is the time and what happened', () => {
    expect(describeDot(dot('pass'))).toBe('Oct 12, 14:03 UTC: passed');
    expect(describeDot(dot('fail'))).toBe('Oct 12, 14:03 UTC: failed');
    expect(describeDot(dot('not_run'))).toBe(
      'Oct 12, 14:03 UTC: did not run (crawl or compile problem)',
    );
    expect(describeDot(dot('harness'))).toBe(
      'Oct 12, 14:03 UTC: harness error (ours, not the vendor)',
    );
    expect(describeDot(dot('skipped'))).toBe('Oct 12, 14:03 UTC: skipped (needs a person)');
  });

  it('marks a stale plan', () => {
    expect(describeDot(dot('pass', { stale: true }))).toBe(
      'Oct 12, 14:03 UTC: passed (stale plan)',
    );
  });

  it('says nothing about why a run failed', () => {
    expect(describeDot(dot('fail'))).not.toMatch(/because|error|exception|cause/i);
  });
});
