import { describe, expect, it } from 'vitest';
import { compareSecrets } from './secret-compare.js';

// The admin token is compared in constant time: both sides are hashed to a fixed length, so neither the length
// nor the position of the first difference can be measured, and the comparison itself is timingSafeEqual.
// (Node only: the Edge-safe session code in admin-session.ts never sees the token.)

describe('compareSecrets', () => {
  it('is true only for equal strings', () => {
    expect(compareSecrets('admin-token-0123456789', 'admin-token-0123456789')).toBe(true);
    expect(compareSecrets('admin-token-0123456789', 'admin-token-0123456780')).toBe(false);
    expect(compareSecrets('', '')).toBe(true);
  });

  it('does not throw and is false for different lengths, an empty string or a unicode lookalike', () => {
    expect(compareSecrets('short', 'a-much-longer-value-than-short')).toBe(false);
    expect(compareSecrets('', 'x')).toBe(false);
    expect(compareSecrets('café', 'café')).toBe(false);
  });

  it('goes through timingSafeEqual on fixed-size digests, never a plain ===', () => {
    const calls: [number, number][] = [];
    const spy = (a: Uint8Array, b: Uint8Array): boolean => {
      calls.push([a.length, b.length]);
      return Buffer.from(a).equals(Buffer.from(b));
    };
    expect(compareSecrets('a', 'bbbbbbbbbbbb', spy)).toBe(false);
    expect(compareSecrets('same', 'same', spy)).toBe(true);
    expect(calls).toEqual([
      [32, 32],
      [32, 32],
    ]);
  });
});
