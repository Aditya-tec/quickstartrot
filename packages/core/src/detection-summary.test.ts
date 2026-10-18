import { describe, expect, it } from 'vitest';
import { DetectionSummary, summariseDetection } from './detection-summary.js';
import { badgeParagraph, l3ProductionSentence, levelStatements } from './detection-wording.js';

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

// the quickstarts that reach L3 in production (from the target files): the two the measurement covers, and one it left out
const PRODUCTION = ['anthropic-node', 'anthropic-python', 'resend-node'];

function raw() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-18T04:35:46.556Z',
    method: { harnessVersion: 2, seed: 'p9c', operators: [], compilerVersion: 'x' },
    controls: { rows: 'not a summary field' },
    summary: {
      controls: {
        total: 51,
        included: 46,
        excluded: [
          {
            slug: 'anthropic-python',
            reason: 'vendor calls are off for this target (pass --allow-vendor-calls to run it)',
          },
          { slug: 'hono-node', reason: 'the control did not pass twice: SKIPPED at s1' },
        ],
      },
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
    const s = summariseDetection(raw(), [], PRODUCTION);
    expect(s.install.L2).toMatchObject({ detected: 68, tested: 68, targets: 34 });
    expect(s.code.L2).toMatchObject({ detected: 64, tested: 121, targets: 35, invalid: 1 });
    expect(s.code.L2.noSite).toBe(53);
    expect(s.install.L3.notRun).toBe(8);
    expect(s.levelTargets).toEqual({ L1: 6, L2: 35, L3: 2, local: 3 });
  });

  it('has no blended figure anywhere: no overall rate, no sum across install and code', () => {
    const s = summariseDetection(raw(), [], PRODUCTION);
    const text = JSON.stringify(s);
    expect(Object.keys(s)).not.toContain('overall');
    expect(text).not.toMatch(/blended|overall|combined/i);
    // 68 + 64 = 132 is the blended count; it must not be present as a value
    expect(text).not.toContain('132');
  });

  it('carries the L3 targets and says how many there are, and the shadow targets apart', () => {
    const s = summariseDetection(raw(), ['slack-node', 'cerebras-python'], PRODUCTION);
    expect(s.l3Targets).toEqual(['anthropic-node', 'resend-node']);
    expect(s.shadowTargets).toEqual(['cerebras-python', 'slack-node']); // sorted, so the file does not change with the order of the input
    expect(s.shadowTargets.some((t) => s.l3Targets.includes(t))).toBe(false);
  });

  it('refuses a shadow target that is also counted at L3', () => {
    expect(() => summariseDetection(raw(), ['resend-node'], PRODUCTION)).toThrow(/both/i);
  });

  it('records the L2 code-level result for each operator, to back the sentence about what L2 sees', () => {
    const s = summariseDetection(raw(), [], PRODUCTION);
    expect(s.codeL2ByOperator['deep_import']).toEqual({ detected: 30, tested: 31 });
    expect(s.codeL2ByOperator['renamed_symbol']).toEqual({ detected: 0, tested: 16 });
    // install-level operators are not code-level
    expect(s.codeL2ByOperator['pkg_typo']).toBeUndefined();
  });

  it('lists the quickstarts that reach L3 in production, which of them the measurement does not cover, and why', () => {
    const s = summariseDetection(raw(), [], PRODUCTION);
    expect(s.l3Production).toEqual(['anthropic-node', 'anthropic-python', 'resend-node']);
    expect(s.l3NotMeasured).toEqual(['anthropic-python']);
    expect(s.l3NotMeasuredVendorCallsOff).toBe(true);
  });

  it('says vendor calls were off only when every uncovered quickstart was recorded as excluded for that reason', () => {
    const r = raw();
    // the uncovered one is now excluded for another reason
    r.summary.controls.excluded = [
      { slug: 'anthropic-python', reason: 'the control did not pass twice' },
    ];
    expect(summariseDetection(r, [], PRODUCTION).l3NotMeasuredVendorCallsOff).toBe(false);
    // ... or is not recorded at all (a quickstart promoted since the measurement)
    const r2 = raw();
    r2.summary.controls.excluded = [];
    expect(summariseDetection(r2, [], PRODUCTION).l3NotMeasuredVendorCallsOff).toBe(false);
  });

  it('covers nothing and says nothing when every production quickstart was measured', () => {
    const s = summariseDetection(raw(), [], ['anthropic-node', 'resend-node']);
    expect(s.l3NotMeasured).toEqual([]);
    expect(s.l3NotMeasuredVendorCallsOff).toBe(false);
  });

  it('refuses a shadow target that is also said to reach L3 in production', () => {
    expect(() => summariseDetection(raw(), ['anthropic-python'], PRODUCTION)).toThrow(/both/i);
  });

  it('copies the date and the harness version it was measured under; a result without a version is version 1', () => {
    const r = raw();
    expect(summariseDetection(r, [], PRODUCTION)).toMatchObject({
      generatedAt: '2026-10-18T04:35:46.556Z',
      harnessVersion: 2,
      targetsMeasured: 46,
      targetsConsidered: 51,
    });
    const old = raw();
    delete (old.method as { harnessVersion?: number }).harnessVersion;
    expect(summariseDetection(old, [], PRODUCTION).harnessVersion).toBe(1);
  });

  it('never stores a rate: only counts, so the page cannot quote a percentage the data does not support', () => {
    const s = summariseDetection(raw(), [], PRODUCTION);
    expect(JSON.stringify(s)).not.toMatch(/"(?:detection|rate|percent\w*|classification)":/i);
  });

  it('is exactly the schema the website validates the file with', () => {
    expect(DetectionSummary.parse(summariseDetection(raw(), ['slack-node'], PRODUCTION))).toEqual(
      summariseDetection(raw(), ['slack-node'], PRODUCTION),
    );
  });

  it('fails loudly on a results file that is not the expected shape', () => {
    expect(() => summariseDetection({}, [], PRODUCTION)).toThrow();
    const broken = raw();
    delete (broken.summary.byKind as { code?: unknown }).code;
    expect(() => summariseDetection(broken, [], PRODUCTION)).toThrow();
  });
});

// The wording the site and the README quote. One definition, so they cannot differ; the approved text is in docs/DETECTION-POWER.md.
describe('badgeParagraph: the approved wording about the badge', () => {
  const summary = () => summariseDetection(raw(), [], PRODUCTION);

  it('is wording B, with every figure read from the data', () => {
    expect(badgeParagraph(summary())).toBe(
      'A green L2 badge means the quickstart installs, parses and its imports resolve. In our own tests, planting broken code in 35 quickstarts, L2 noticed 64 of 121 planted breakages, all of them syntax errors and import paths that do not exist; it noticed none of the 55 renamed names, renamed methods or misnamed options, because those only exist at run time. Level 3, where the snippet reaches the vendor, rests on 2 quickstarts so far and we quote no rate for it. (Broken install commands are caught by npm and pip, 90 of 90, and say nothing about the code.)',
    );
  });

  it('drops the claim that level 2 only saw syntax errors and import paths when it saw something else', () => {
    const d = summary();
    const m = d.codeL2ByOperator['renamed_method'];
    if (!m) throw new Error('fixture');
    m.detected = 1;
    d.code.L2.detected += 1;
    const t = badgeParagraph(d);
    expect(t).not.toContain('all of them syntax errors');
    expect(t).toContain('it noticed 1 of the 55 renamed names');
  });

  it('uses the singular for one quickstart and never quotes a level 3 rate', () => {
    const d = summary();
    d.l3Targets = ['only-one'];
    d.code.L2.targets = 1;
    const t = badgeParagraph(d);
    expect(t).toContain('rests on 1 quickstart so far');
    expect(t).toContain('planting broken code in 1 quickstart,');
    expect(t).not.toMatch(/%/);
  });

  it('adds no figure across install-level and code-level mutants', () => {
    expect(badgeParagraph(summary())).not.toContain('154 of');
  });
});

describe('levelStatements: what a pass tells you at each level', () => {
  const s = () => summariseDetection(raw(), [], PRODUCTION);

  it('quotes the L2 counts for the names that only exist at run time, from the data', () => {
    expect(levelStatements(s()).L2).toBe(
      'A pass at L2 means the install works, the code parses, and the packages it imports resolve. It does not mean the names the code uses still exist: at L2 our planted renamed imports were noticed 0 of 16 times, renamed methods 0 of 15 and misnamed options 0 of 24.',
    );
  });

  it('names the quickstarts level 3 rests on and quotes no rate for it', () => {
    const t = levelStatements(s()).L3;
    expect(t).toContain('rests on 2 quickstarts (anthropic-node, resend-node)');
    expect(t).toContain('we quote no detection rate for it');
    expect(t).not.toMatch(/%/);
  });

  it('keeps the executed-locally category out of level 3', () => {
    expect(levelStatements(s()).local).toContain('3 targets are of that kind here');
    expect(levelStatements(s()).local).toContain('it never counts as Level 3');
  });

  it('says L1 only means the package installs', () => {
    expect(levelStatements(s()).L1).toBe(
      'A pass at L1 means the package named in the install command exists and installs on a clean machine today. It does not say the code works.',
    );
  });
});

// One sentence, generated: how many quickstarts reach L3 in production, and how many of them the detection measurement covers.
describe('l3ProductionSentence', () => {
  const summary = (production = PRODUCTION) => summariseDetection(raw(), [], production);

  it('says three reach L3 in production, the measurement covers two, and why', () => {
    expect(l3ProductionSentence(summary())).toBe(
      '3 quickstarts reach L3 in production; the detection measurement covers 2 of them, because vendor calls are off during mutation runs.',
    );
  });

  it('says it covers all of them when it does', () => {
    expect(l3ProductionSentence(summary(['anthropic-node', 'resend-node']))).toBe(
      '2 quickstarts reach L3 in production, and the detection measurement covers all of them.',
    );
  });

  it('does not blame vendor calls for a gap that has another cause', () => {
    const r = raw();
    r.summary.controls.excluded = [];
    const s = summariseDetection(r, [], PRODUCTION);
    expect(l3ProductionSentence(s)).toBe(
      '3 quickstarts reach L3 in production; the detection measurement covers 2 of them.',
    );
  });

  it('uses the singular for one', () => {
    const r = raw();
    r.summary.l3Targets = ['anthropic-node'];
    r.summary.levelTargets.L3 = 1;
    expect(l3ProductionSentence(summariseDetection(r, [], ['anthropic-node']))).toBe(
      '1 quickstart reaches L3 in production, and the detection measurement covers all of them.',
    );
  });

  it('says so, and quotes no rate, when nothing reaches L3 in production', () => {
    const r = raw();
    r.summary.l3Targets = [];
    r.summary.levelTargets.L3 = 0;
    const t = l3ProductionSentence(summariseDetection(r, [], []));
    expect(t).toBe('No quickstart reaches L3 in production yet.');
    expect(t).not.toMatch(/%/);
  });

  it('counts a measured quickstart that is no longer at L3 in production as not covering anything', () => {
    // resend-node was measured at L3 but has since been demoted: it is not one of the production quickstarts
    expect(l3ProductionSentence(summary(['anthropic-node', 'anthropic-python']))).toBe(
      '2 quickstarts reach L3 in production; the detection measurement covers 1 of them, because vendor calls are off during mutation runs.',
    );
  });
});
