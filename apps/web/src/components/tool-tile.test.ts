import { describe, expect, it } from 'vitest';
import { tileHue, tileLetter } from './tool-table';

// The decorative tile in front of a quickstart's name: its first letter and a colour taken from the name, so the same name always looks the same.
describe('tile', () => {
  it('shows the first letter, upper-cased, and a question mark for an empty name', () => {
    expect(tileLetter('python-dotenv')).toBe('P');
    expect(tileLetter('  zod')).toBe('Z');
    expect(tileLetter('')).toBe('?');
  });

  it('has a stable hue between 0 and 359 that depends on the name', () => {
    expect(tileHue('Resend')).toBe(tileHue('Resend'));
    expect(tileHue('Resend')).toBeGreaterThanOrEqual(0);
    expect(tileHue('Resend')).toBeLessThan(360);
    expect(tileHue('Resend')).not.toBe(tileHue('Zod'));
  });
});
