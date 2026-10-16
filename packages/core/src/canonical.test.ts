import { describe, expect, it } from 'vitest';
import { canonicalJson, hashJson } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('is the same for objects built in a different key order', () => {
    expect(canonicalJson({ x: 1, y: [{ q: 1, p: 2 }] })).toBe(
      canonicalJson({ y: [{ p: 2, q: 1 }], x: 1 }),
    );
  });

  it('handles scalars', () => {
    expect([
      canonicalJson(1),
      canonicalJson('s'),
      canonicalJson(null),
      canonicalJson(true),
    ]).toEqual(['1', '"s"', 'null', 'true']);
  });
});

describe('hashJson', () => {
  it('is a stable sha256 hex digest of the canonical form', () => {
    expect(hashJson({ a: 1, b: 2 })).toMatch(/^[0-9a-f]{64}$/);
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});
