import { describe, expect, it } from 'vitest';
import { clipText, ogCard } from './og';

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
