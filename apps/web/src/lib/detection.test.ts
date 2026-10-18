import { describe, expect, it } from 'vitest';
import type { DetectionSummary } from '@qsr/core/public';
import { DETECTION, l2Findings } from './detection';

const clone = (): DetectionSummary => structuredClone(DETECTION);

describe('DETECTION', () => {
  it('is the committed file, parsed', () => {
    expect(DETECTION.schemaVersion).toBe(1);
    expect(DETECTION.l3Targets.length).toBe(DETECTION.levelTargets.L3);
  });
});

describe('l2Findings: what a level 2 pass did and did not see', () => {
  it('reads the counts from the data: code-level mutants at L2, and the names that only exist at run time', () => {
    const f = l2Findings(DETECTION);
    expect(f.targets).toBe(DETECTION.code.L2.targets);
    expect(f.detected).toBe(DETECTION.code.L2.detected);
    expect(f.tested).toBe(DETECTION.code.L2.tested);
    const ops = DETECTION.codeL2ByOperator;
    expect(f.runtimeTested).toBe(
      (ops['renamed_symbol']?.tested ?? 0) +
        (ops['renamed_method']?.tested ?? 0) +
        (ops['option_misnamed']?.tested ?? 0),
    );
    expect(f.runtimeDetected).toBe(0);
  });

  it('says every noticed breakage was a syntax error or an import path only when that is the whole count', () => {
    expect(l2Findings(DETECTION).onlySyntaxAndImports).toBe(true);
    const d = clone();
    const m = d.codeL2ByOperator['renamed_symbol'];
    if (!m) throw new Error('fixture');
    m.detected = 1;
    d.code.L2.detected += 1;
    const f = l2Findings(d);
    expect(f.onlySyntaxAndImports).toBe(false);
    expect(f.runtimeDetected).toBe(1);
  });

  it('a missing operator counts as nothing tested, not as an error', () => {
    const d = clone();
    d.codeL2ByOperator = {};
    expect(l2Findings(d)).toMatchObject({ runtimeTested: 0, runtimeDetected: 0 });
  });
});
