import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DetectionSummary } from '@qsr/core/public';
import { DETECTION } from '@/lib/detection';
import { DetectionPower } from './detection-power';

// The detection-power section of /methodology. Every figure on it comes from DETECTION (apps/web/src/data/detection-power.json, which
// `qsr detection-summary` writes from docs/detection-power.json), and the wording keeps three rules: install-level and code-level
// mutants are never blended, level 3 is quoted as a number of targets and never as a rate, and a shadow target is labelled verifying.

const html = (data: DetectionSummary): string =>
  renderToStaticMarkup(<DetectionPower data={data} />);
const text = (data: DetectionSummary): string =>
  html(data)
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll(/&[a-z]+;|&#x?\d+;/gi, ' ')
    .replaceAll(/\s+/g, ' ');
const clone = (): DetectionSummary => structuredClone(DETECTION);

describe('the numbers are the data’s', () => {
  const real = text(DETECTION);

  it('states the badge result for level 2 in the approved wording, with the data’s counts', () => {
    const c = DETECTION.code.L2;
    const ops = DETECTION.codeL2ByOperator;
    const runtimeNames =
      (ops['renamed_symbol']?.tested ?? 0) +
      (ops['renamed_method']?.tested ?? 0) +
      (ops['option_misnamed']?.tested ?? 0);
    expect(real).toContain(
      'A green L2 badge means the quickstart installs, parses and its imports resolve.',
    );
    expect(real).toContain(
      `planting broken code in ${c.targets} quickstarts, L2 noticed ${c.detected} of ${c.tested} planted breakages, all of them syntax errors and import paths that do not exist`,
    );
    expect(real).toContain(
      `it noticed none of the ${runtimeNames} renamed names, renamed methods or misnamed options, because those only exist at run time`,
    );
  });

  it('does not say “all of them syntax errors and import paths” when something else was noticed at level 2', () => {
    const d = clone();
    const m = d.codeL2ByOperator['renamed_method'];
    if (!m) throw new Error('fixture');
    m.detected = 1;
    d.code.L2.detected += 1;
    const t = text(d);
    expect(t).not.toContain('all of them syntax errors');
    expect(t).not.toContain('it noticed none of the');
    expect(t).toContain(`${d.code.L2.detected} of ${d.code.L2.tested}`);
  });

  it('has no hand-typed figure: every number moves when the data moves', () => {
    const other = clone();
    let i = 0;
    const bump = (cell: Record<string, number>): void => {
      for (const k of Object.keys(cell)) cell[k] = (cell[k] ?? 0) + 101 + i++ * 3;
    };
    for (const level of ['L1', 'L2', 'L3', 'local'] as const) {
      bump(other.install[level]);
      bump(other.code[level]);
    }
    for (const k of Object.keys(other.levelTargets) as (keyof typeof other.levelTargets)[])
      other.levelTargets[k] += 101 + i++ * 3;
    for (const op of Object.values(other.codeL2ByOperator)) bump(op);
    other.targetsMeasured += 101;
    other.targetsConsidered += 207;
    other.harnessVersion += 305;
    other.l3Targets = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    other.shadowTargets = ['h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'];
    other.generatedAt = '2031-03-07T01:02:03.000Z';

    const figures = (s: string): Map<string, number> => {
      const m = new Map<string, number>();
      // "Level 3" and "L3" name a level; they are definitions, not figures (the same exception honesty.test.tsx makes)
      const cleaned = s.replaceAll(/\bLevel \d\b/gi, ' ').replaceAll(/\bL\d\b/g, ' ');
      for (const f of cleaned.match(/\b\d+(?:\.\d+)?%?/g) ?? []) m.set(f, (m.get(f) ?? 0) + 1);
      return m;
    };
    const a = figures(real);
    const b = figures(text(other));
    // a figure that appears the same number of times in both renderings was typed into the page, not read from the data
    const stuck = [...a.entries()].filter(([f, n]) => b.get(f) === n).map(([f]) => f);
    expect(stuck, `hand-typed figures: ${stuck.join(', ')}`).toEqual([]);
  });
});

describe('install-level and code-level are never blended', () => {
  it('has one table for each kind and no table or sentence that adds them', () => {
    const h = html(DETECTION);
    expect(h.match(/<table/g)).toHaveLength(2);
    expect(h).toMatch(/Install-level mutants/);
    expect(h).toMatch(/Code-level mutants/);
    const t = text(DETECTION);
    expect(t).not.toMatch(/\b(overall|blended|combined|on average|average)\b/i);
    const sum = DETECTION.install.L2.detected + DETECTION.code.L2.detected;
    const total = DETECTION.install.L2.tested + DETECTION.code.L2.tested;
    expect(t).not.toContain(`${sum} of ${total}`);
  });

  it('shows each level with its denominators: targets at the level, tested, noticed, and what was left out', () => {
    const h = html(DETECTION);
    for (const kind of ['install', 'code'] as const) {
      for (const level of ['L1', 'L2', 'local'] as const) {
        const c = DETECTION[kind][level];
        if (c.tested === 0) continue;
        expect(h, `${kind} ${level}`).toContain(`${c.detected} of ${c.tested}`);
      }
    }
    expect(text(DETECTION)).toContain(`${DETECTION.code.L2.noSite}`);
  });

  it('puts the executed-locally category beside the levels, not inside level 3', () => {
    const t = text(DETECTION);
    expect(t).toMatch(/Executed locally \(no vendor\)/);
    expect(t).toContain(`${DETECTION.levelTargets.local} targets`);
    expect(t).toMatch(/never counts as Level 3/);
  });
});

describe('level 3', () => {
  it('is quoted as the number of targets it rests on, with their names, and never as a rate', () => {
    const t = text(DETECTION);
    const n = DETECTION.l3Targets.length;
    expect(t).toContain(`rests on ${n} quickstarts so far and we quote no rate for it`);
    for (const slug of DETECTION.l3Targets) expect(t).toContain(slug);
    // no percentage in a level 3 row
    const rows = [...html(DETECTION).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((m) => m[1] ?? '')
      .filter((r) => /^\s*<t[hd][^>]*>\s*L3\b/.test(r));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r).not.toMatch(/\d%/);
      expect(r).toContain('not quoted');
    }
  });

  it('quotes a rate only for a level whose denominator is real: no percentage when a level has nothing tested', () => {
    const d = clone();
    d.code.L1 = { ...d.code.L1, detected: 0, tested: 0 };
    const t = text(d);
    expect(t).not.toMatch(/NaN|Infinity/);
  });

  it('labels each shadow target as verifying, says it is not counted, and lists them apart from the counted ones', () => {
    const t = text(DETECTION);
    const n = DETECTION.shadowTargets.length;
    expect(n).toBeGreaterThan(0);
    expect(t).toContain(`${n} more quickstarts run their Level 3 step as a trial`);
    expect(t).toMatch(/verifying/i);
    expect(t).toMatch(/not counted/);
    for (const slug of DETECTION.shadowTargets) expect(t).toContain(slug);
    // a shadow target is never in the list that level 3 rests on
    for (const slug of DETECTION.shadowTargets) expect(DETECTION.l3Targets).not.toContain(slug);
  });

  it('says nothing about shadow targets when there are none', () => {
    const d = clone();
    d.shadowTargets = [];
    expect(text(d)).not.toMatch(/as a trial/);
  });

  it('uses the singular for one target', () => {
    const d = clone();
    d.l3Targets = ['only-one'];
    d.shadowTargets = ['just-one'];
    const t = text(d);
    expect(t).toContain('rests on 1 quickstart so far');
    expect(t).toContain('1 more quickstart runs its Level 3 step as a trial');
  });
});

describe('what the section does not claim', () => {
  it('says it is a measurement of the monitor and not of how often real quickstarts break', () => {
    expect(text(DETECTION)).toMatch(
      /None of this measures how often real quickstarts break\. It measures what the monitor can see\./,
    );
  });

  it('dates the measurement and names the harness version it ran under', () => {
    const t = text(DETECTION);
    expect(t).toContain(`harness version ${DETECTION.harnessVersion}`);
    expect(t).toMatch(/18 October 2026/);
  });

  it('links to the raw document and the data in the repository', () => {
    const h = html(DETECTION);
    expect(h).toContain('docs/DETECTION-POWER.md');
    expect(h).toContain('docs/detection-power.json');
  });

  it('leaves out mutants that had no site to change, and says how many, apart from every rate', () => {
    const t = text(DETECTION);
    const none =
      DETECTION.code.L1.noSite +
      DETECTION.code.L2.noSite +
      DETECTION.code.L3.noSite +
      DETECTION.code.local.noSite;
    expect(t).toContain(
      `${none + DETECTION.install.L1.noSite + DETECTION.install.L2.noSite + DETECTION.install.L3.noSite + DETECTION.install.local.noSite} mutants had no site to change`,
    );
  });
});

describe('accessibility', () => {
  // A table that scrolls sideways on a phone must be reachable by keyboard and have a name (axe: scrollable-region-focusable).
  it('makes each table’s scroll area focusable and names it after the table', () => {
    const h = html(DETECTION);
    const regions = [...h.matchAll(/<div[^>]*overflow-x-auto[^>]*>/g)].map((m) => m[0]);
    expect(regions).toHaveLength(2);
    for (const r of regions) {
      expect(r).toContain('tabindex="0"');
      expect(r).toContain('role="region"');
    }
    expect(regions[0]).toContain('aria-label="Install-level mutants, scrollable"');
    expect(regions[1]).toContain('aria-label="Code-level mutants, scrollable"');
  });

  it('gives every column header and row header a scope', () => {
    const h = html(DETECTION);
    expect(h).not.toMatch(/<th(?=[\s>])(?![^>]*scope=)/);
  });
});
