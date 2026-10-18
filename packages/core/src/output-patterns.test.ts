import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_AUTH_PATTERNS, AUTH_PATTERNS, VENDOR_AUTH_PATTERNS } from './output-patterns.js';

// P9d follow-up: an L3 pass needs evidence in the step output. The evidence is a spec auth pattern or a REGISTERED vendor pattern.
// A vendor pattern may only come from output a real run produced: each one has a fixture of it, and the fixture must match it.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'fixtures', 'vendor-output');

describe('vendor auth patterns', () => {
  it('are separate from the spec patterns, which stay exactly as the spec has them', () => {
    expect(ALL_AUTH_PATTERNS).toEqual([...AUTH_PATTERNS, ...VENDOR_AUTH_PATTERNS]);
    expect(VENDOR_AUTH_PATTERNS.length).toBeGreaterThan(0);
    for (const p of VENDOR_AUTH_PATTERNS) {
      expect(p.id.startsWith(`${p.vendor}:`), p.id).toBe(true);
      expect(AUTH_PATTERNS.some((s) => s.id === p.id)).toBe(false);
    }
  });

  it('every one has a fixture of REAL output for its vendor, and the pattern matches it', () => {
    for (const p of VENDOR_AUTH_PATTERNS) {
      const text = readFileSync(path.join(FIXTURES, `${p.vendor}.txt`), 'utf8');
      expect(
        text.split('\n').some((line) => p.re.test(line)),
        `${p.id} does not match its fixture`,
      ).toBe(true);
    }
  });

  it('every fixture belongs to a registered vendor (no orphan evidence)', () => {
    const vendors = new Set(VENDOR_AUTH_PATTERNS.map((p) => p.vendor));
    for (const f of readdirSync(FIXTURES))
      expect(vendors.has(f.replace(/\.txt$/, '')), f).toBe(true);
  });

  it('Resend: "API key is invalid" is evidence, and an ordinary 200 reply is not', () => {
    const resend = VENDOR_AUTH_PATTERNS.find((p) => p.vendor === 'resend');
    expect(resend?.re.test("message: 'API key is invalid',")).toBe(true);
    expect(resend?.re.test('{ data: { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" } }')).toBe(false);
  });
});
