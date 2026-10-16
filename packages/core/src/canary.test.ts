import { describe, expect, it } from 'vitest';
import {
  CANARY_EXPECTATIONS,
  CANARY_SLUGS,
  checkCanaries,
  compileConfigHash,
  isCanarySlug,
  Target,
  type CanaryObservation,
  type TargetInput,
} from './index.js';

// Spec section 6 and 10: four canaries run in every cycle; a wrong or missing result makes the cycle invalid.

const observed = (
  over: Partial<Record<string, Partial<CanaryObservation>>> = {},
): CanaryObservation[] =>
  CANARY_SLUGS.map((slug) => ({
    slug,
    outcome: CANARY_EXPECTATIONS[slug].outcome,
    failureClass: CANARY_EXPECTATIONS[slug].failureClass,
    ...over[slug],
  }));

describe('CANARY_EXPECTATIONS', () => {
  it('is the table in targets/_canary/canaries.json: two that must pass, two that must fail with a known class', () => {
    expect(CANARY_SLUGS).toEqual([
      'canary-pass-node',
      'canary-pass-python',
      'canary-fail-drift',
      'canary-fail-dep',
    ]);
    expect(CANARY_EXPECTATIONS['canary-pass-node']).toEqual({
      outcome: 'PASS',
      failureClass: null,
    });
    expect(CANARY_EXPECTATIONS['canary-pass-python']).toEqual({
      outcome: 'PASS',
      failureClass: null,
    });
    expect(CANARY_EXPECTATIONS['canary-fail-drift']).toEqual({
      outcome: 'FAIL',
      failureClass: 'API_DRIFT',
    });
    expect(CANARY_EXPECTATIONS['canary-fail-dep']).toEqual({
      outcome: 'FAIL',
      failureClass: 'DEPENDENCY_RESOLUTION',
    });
  });

  it('isCanarySlug', () => {
    expect(isCanarySlug('canary-pass-node')).toBe(true);
    expect(isCanarySlug('canary-anything')).toBe(true);
    expect(isCanarySlug('chalk-node')).toBe(false);
    expect(isCanarySlug('my-canary-tool')).toBe(false);
  });
});

describe('checkCanaries', () => {
  it('is ok when every canary gave its expected outcome and class', () => {
    expect(checkCanaries(observed())).toEqual({ ok: true, problems: [] });
  });

  it('a canary that should pass but failed makes the cycle invalid', () => {
    const r = checkCanaries(
      observed({ 'canary-pass-node': { outcome: 'FAIL', failureClass: 'API_DRIFT' } }),
    );
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['canary-pass-node: expected PASS but got FAIL (API_DRIFT)']);
  });

  it('a canary that should fail but passed makes the cycle invalid', () => {
    const r = checkCanaries(
      observed({ 'canary-fail-drift': { outcome: 'PASS', failureClass: null } }),
    );
    expect(r.problems).toEqual(['canary-fail-drift: expected FAIL (API_DRIFT) but got PASS']);
  });

  it('a canary that failed with the wrong class makes the cycle invalid', () => {
    const r = checkCanaries(observed({ 'canary-fail-dep': { failureClass: 'NETWORK_TRANSIENT' } }));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'canary-fail-dep: expected FAIL (DEPENDENCY_RESOLUTION) but got FAIL (NETWORK_TRANSIENT)',
    ]);
  });

  it('a harness error or skip is never an acceptable canary result', () => {
    for (const outcome of ['HARNESS_ERROR', 'SKIPPED'] as const) {
      expect(
        checkCanaries(observed({ 'canary-pass-python': { outcome, failureClass: null } })).ok,
      ).toBe(false);
    }
  });

  it('a MISSING canary makes the cycle invalid, and says which', () => {
    const r = checkCanaries(observed().filter((o) => o.slug !== 'canary-fail-dep'));
    expect(r).toEqual({ ok: false, problems: ['canary-fail-dep: no result in this cycle'] });
    expect(checkCanaries([]).problems).toHaveLength(4);
  });

  it('collects every problem, and ignores observations that are not canaries', () => {
    const r = checkCanaries([
      ...observed({
        'canary-pass-node': { outcome: 'FAIL' },
        'canary-fail-drift': { outcome: 'PASS', failureClass: null },
      }),
      { slug: 'chalk-node', outcome: 'FAIL', failureClass: 'API_DRIFT' },
    ]);
    expect(r.problems).toHaveLength(2);
  });
});

describe('compileConfigHash', () => {
  const base: TargetInput = {
    slug: 'acme-node',
    name: 'Acme',
    docsUrl: 'https://example.com/docs',
    language: 'node',
    level: 3,
    runtime: { image: 'qsr-node:22' },
    extract: { root: 'main', variants: { splitOn: ['//\s*ESM'], prefer: 'ESM' } },
    placeholders: { A: 'x', B: 'y' },
  };
  const hash = (over: Partial<TargetInput> = {}) =>
    compileConfigHash(Target.parse({ ...base, ...over }));

  it('is a sha256 hex digest and is stable', () => {
    expect(hash()).toMatch(/^[0-9a-f]{64}$/);
    expect(hash()).toBe(hash());
  });

  it.each([
    ['placeholders', { placeholders: { A: 'x', B: 'changed' } }],
    ['level', { level: 2 }],
    ['language', { language: 'python' as const }],
    [
      'extract.variants.prefer',
      { extract: { root: 'main', variants: { splitOn: ['//\s*ESM'], prefer: 'CJS' } } },
    ],
    [
      'extract.variants.splitOn',
      { extract: { root: 'main', variants: { splitOn: ['//\s*ES'], prefer: 'ESM' } } },
    ],
  ])(
    'changes when %s changes (it changes what the model is told or what the crawler keeps)',
    (_name, over) => {
      expect(hash(over)).not.toBe(hash());
    },
  );

  it.each([
    ['name', { name: 'Renamed' }],
    ['notes', { notes: 'edited' }],
    ['owners', { owners: { x: '@vendor' } }],
    ['timeoutSec', { expect: { authErrorIsPass: false, timeoutSec: 100 } }],
    ['docsUrl', { docsUrl: 'https://example.com/other' }],
  ])('does NOT change when %s changes: editing it must not recompile', (_name, over) => {
    expect(hash(over)).toBe(hash());
  });

  it('does not depend on the order of placeholder keys, and a target without variants has its own hash', () => {
    expect(hash({ placeholders: { B: 'y', A: 'x' } })).toBe(hash());
    expect(hash({ extract: { root: 'main' } })).not.toBe(hash());
  });
});
