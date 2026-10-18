import { describe, expect, it } from 'vitest';
import { numbersIn } from './numbers-in.js';

// docs/CLAIMS.md lists every figure that could appear in a public post. numbersIn is how a test finds the figures in a page or in the README:
// digits and decimals, number words and ordinals (a page says "six hours" and "the second failure"), as digits. The names of levels and
// versions (L3, Level 3, v2) are names, not figures.

describe('numbersIn', () => {
  it('reads digits, decimals, number words and ordinals, and leaves out level and version names', () => {
    expect(
      [
        ...numbersIn(
          'Every six hours, twice, the second failure: 64 of 121 (53%), 1.3% at L3 in harness v2, Level 3',
        ),
      ].sort(),
    ).toEqual(['1.3', '121', '2', '53', '6', '64'].sort());
  });

  it('reads the parts of a date and a time', () => {
    expect([...numbersIn('2026-10-18 11:23 UTC')].sort()).toEqual(
      ['10', '11', '18', '2026', '23'].sort(),
    );
  });

  it('finds nothing in a text without figures', () => {
    expect(numbersIn('No quickstart has been tested yet. L2 and L3 are levels.').size).toBe(0);
  });

  it('reads once and twice as 1 and 2, and every number word to twelve', () => {
    expect([...numbersIn('once')]).toEqual(['1']);
    expect([...numbersIn('twice')]).toEqual(['2']);
    for (const [word, n] of [
      ['three', '3'],
      ['seven', '7'],
      ['twelve', '12'],
      ['tenth', '10'],
    ] as const)
      expect([...numbersIn(word)], word).toEqual([n]);
  });

  it('does not take the digit out of a word like L2 or v2 when it is part of a name', () => {
    expect(numbersIn('v2 L2 L3').size).toBe(0);
  });
});
