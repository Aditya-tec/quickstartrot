import { describe, expect, it } from 'vitest';
import { DetectionSummary, summariseDetection } from './detection-summary.js';

// What the public /methodology page says about the monitor's detection power is derived from docs/detection-power.json by this
// function, and nothing else. It never adds the install and code kinds together and it never invents a rate.

const cell = (detected: number, survived: number, extra: Record<string, number> = {}) => ({
  detected,
  survived,
  tested: detected + survived,
  detection: detected + survived === 0 ? null : detected / (detected + survived),
  classified: detected,
  classCorrect: detected,
  classification: detected === 0 ? null : 1,
  invalid: 0,
  notApplicable: 0,
  harnessError: 0,
  notRun: 0,
  targets: 0,
  ...extra,
});

function raw() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-18T04:35:46.556Z',
    method: { harnessVersion: 2, seed: 'p9c', operators: [], compilerVersion: 'x' },
    controls: { rows: 'not a summary field' },
    summary: {
      controls: { total: 51, included: 46, excluded: [] },
      levelTargets: { L1: 6, L2: 35, L3: 2, local: 3 },
      l3Targets: ['anthropic-node', 'resend-node'],
      noSite: { install: 2, code: 95 },
      byKind: {
        install: {
          L1: cell(12, 0, { targets: 6 }),
          L2: cell(68, 0, { targets: 34, notApplicable: 2 }),
          L3: cell(4, 0, { targets: 2, notRun: 8 }),
          local: cell(6, 0, { targets: 3 }),
        },
        code: {
          L1: cell(0, 0, { notApplicable: 30 }),
          L2: cell(64, 57, { targets: 35, notApplicable: 53, invalid: 1 }),
          L3: cell(7, 2, { targets: 2, notRun: 16 }),
          local: cell(8, 0, { targets: 3 }),
        },
      },
      byOperatorLevel: {
        deep_import: { L2: cell(30, 1) },
        syntax_error: { L2: cell(34, 1) },
        renamed_symbol: { L2: cell(0, 16) },
        renamed_method: { L2: cell(0, 15) },
        option_misnamed: { L2: cell(0, 24) },
        pkg_typo: { L2: cell(34, 0) },
      },
    },
  };
}

describe('summariseDetection', () => {
  it('keeps install-level and code-level apart, per level, with their denominators', () => {
    const s = summariseDetection(raw(), []);
    expect(s.install.L2).toMatchObject({ detected: 68, tested: 68, targets: 34 });
    expect(s.code.L2).toMatchObject({ detected: 64, tested: 121, targets: 35, invalid: 1 });
    expect(s.code.L2.noSite).toBe(53);
    expect(s.install.L3.notRun).toBe(8);
    expect(s.levelTargets).toEqual({ L1: 6, L2: 35, L3: 2, local: 3 });
  });

  it('has no blended figure anywhere: no overall rate, no sum across install and code', () => {
    const s = summariseDetection(raw(), []);
    const text = JSON.stringify(s);
    expect(Object.keys(s)).not.toContain('overall');
    expect(text).not.toMatch(/blended|overall|combined/i);
    // 68 + 64 = 132 is the blended count; it must not be present as a value
    expect(text).not.toContain('132');
  });

  it('carries the L3 targets and says how many there are, and the shadow targets apart', () => {
    const s = summariseDetection(raw(), ['slack-node', 'cerebras-python']);
    expect(s.l3Targets).toEqual(['anthropic-node', 'resend-node']);
    expect(s.shadowTargets).toEqual(['cerebras-python', 'slack-node']); // sorted, so the file does not change with the order of the input
    expect(s.shadowTargets.some((t) => s.l3Targets.includes(t))).toBe(false);
  });

  it('refuses a shadow target that is also counted at L3', () => {
    expect(() => summariseDetection(raw(), ['resend-node'])).toThrow(/both/i);
  });

  it('records the L2 code-level result for each operator, to back the sentence about what L2 sees', () => {
    const s = summariseDetection(raw(), []);
    expect(s.codeL2ByOperator['deep_import']).toEqual({ detected: 30, tested: 31 });
    expect(s.codeL2ByOperator['renamed_symbol']).toEqual({ detected: 0, tested: 16 });
    // install-level operators are not code-level
    expect(s.codeL2ByOperator['pkg_typo']).toBeUndefined();
  });

  it('copies the date and the harness version it was measured under; a result without a version is version 1', () => {
    const r = raw();
    expect(summariseDetection(r, [])).toMatchObject({
      generatedAt: '2026-10-18T04:35:46.556Z',
      harnessVersion: 2,
      targetsMeasured: 46,
      targetsConsidered: 51,
    });
    const old = raw();
    delete (old.method as { harnessVersion?: number }).harnessVersion;
    expect(summariseDetection(old, []).harnessVersion).toBe(1);
  });

  it('never stores a rate: only counts, so the page cannot quote a percentage the data does not support', () => {
    const s = summariseDetection(raw(), []);
    expect(JSON.stringify(s)).not.toMatch(/"(?:detection|rate|percent\w*|classification)":/i);
  });

  it('is exactly the schema the website validates the file with', () => {
    expect(DetectionSummary.parse(summariseDetection(raw(), ['slack-node']))).toEqual(
      summariseDetection(raw(), ['slack-node']),
    );
  });

  it('fails loudly on a results file that is not the expected shape', () => {
    expect(() => summariseDetection({}, [])).toThrow();
    const broken = raw();
    delete (broken.summary.byKind as { code?: unknown }).code;
    expect(() => summariseDetection(broken, [])).toThrow();
  });
});
