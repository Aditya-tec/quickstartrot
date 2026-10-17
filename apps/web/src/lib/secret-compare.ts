import { createHash, timingSafeEqual } from 'node:crypto';

// Node only (never imported by the middleware). Both values are hashed to 32 bytes first, so the comparison
// takes the same time whatever their lengths, then compared with timingSafeEqual.

type Equal = (a: Uint8Array, b: Uint8Array) => boolean;

const digest = (value: string): Uint8Array => createHash('sha256').update(value, 'utf8').digest();

export function compareSecrets(
  given: string,
  expected: string,
  equal: Equal = timingSafeEqual,
): boolean {
  return equal(digest(given), digest(expected));
}
