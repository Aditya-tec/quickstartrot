import { describe, expect, it } from 'vitest';
import { DETECTION, l2Findings } from './detection';
import { clipText, methodologyCard, ogCard } from './og';

// The Open Graph image of a tool shows its status, and for a CONFIRMED failure the failing error line. Nothing
// else may add a cause.

describe('ogCard', () => {
  const base = {
    name: 'Chalk',
    failingSince: '2026-10-12T04:00:00.000Z',
    errorLine: 'TypeError: chalk.red is not a function',
  };

  it('shows the error line and the since text only for a failing tool', () => {
    const card = ogCard({ ...base, status: 'failing' });
    expect(card.errorLine).toBe('TypeError: chalk.red is not a function');
    expect(card.since).toBe('Quickstart failing since Oct 12');
    expect(card.statusLabel).toBe('Failing');
  });

  it.each(['passing', 'verifying', 'unknown', 'needs_person'] as const)(
    'drops the error line and since text for %s, whatever the input says',
    (status) => {
      const card = ogCard({ ...base, status });
      expect(card.errorLine).toBeNull();
      expect(card.since).toBeNull();
    },
  );

  it('truncates a long name and a long error line', () => {
    const card = ogCard({
      name: 'N'.repeat(200),
      status: 'failing',
      failingSince: null,
      errorLine: 'e'.repeat(400),
    });
    expect(card.title.length).toBeLessThanOrEqual(48);
    expect(card.errorLine?.length).toBeLessThanOrEqual(110);
    expect(card.since).toBeNull();
  });
});

describe('clipText', () => {
  it('collapses whitespace and removes control and bidi characters', () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    expect(clipText(`a${rlo}b\n\n  c${zwsp}d\u0000e`, 50)).toBe('a b c d e');
  });
  it('keeps markup as plain characters (an image never interprets it)', () => {
    expect(clipText('<script>alert(1)</script>', 50)).toBe('<script>alert(1)</script>');
  });
});

// The social image of /methodology: the same level 2 result the page quotes, from the same data, with no rate and no blended figure.
describe('methodologyCard', () => {
  it('quotes the level 2 code-level result and what it did not see, from the data', () => {
    const f = l2Findings(DETECTION);
    const card = methodologyCard(DETECTION);
    expect(card.lead).toBe(`${f.detected} of ${f.tested}`);
    expect(card.rest).toContain('planted code breakages noticed at Level 2');
    expect(card.rest).toContain(
      `none of the ${f.runtimeTested} renamed names, renamed methods or misnamed options`,
    );
  });

  it('says level 3 rests on a number of targets and quotes no rate for it', () => {
    const card = methodologyCard(DETECTION);
    expect(card.footer).toContain(
      `Level 3 rests on ${DETECTION.l3Targets.length} quickstarts and has no rate`,
    );
  });

  it('has no percentage, nothing blended and no claim about real quickstarts breaking', () => {
    const card = methodologyCard(DETECTION);
    const all = `${card.lead} ${card.rest} ${card.footer}`;
    expect(all).not.toMatch(/%|overall|blended|average|combined/i);
    expect(all).not.toMatch(/\b(?:of all|most|many) quickstarts (?:break|are broken|fail)/i);
  });

  it('changes with the data: no figure is typed into the image', () => {
    const d = structuredClone(DETECTION);
    d.code.L2.detected = 7;
    d.code.L2.tested = 11;
    const card = methodologyCard(d);
    expect(card.lead).toBe('7 of 11');
  });

  it('does not say "none" when something that only exists at run time was noticed', () => {
    const d = structuredClone(DETECTION);
    const m = d.codeL2ByOperator['renamed_method'];
    if (!m) throw new Error('fixture');
    m.detected = 2;
    expect(methodologyCard(d).rest).not.toMatch(/none of the/);
  });
});
