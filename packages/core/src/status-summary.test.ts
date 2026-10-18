import { describe, expect, it } from 'vitest';
import { PublicStatusSummary } from './status-summary.js';

// GET /api/status on the website: the counts behind the home headline, for the README and the launch check. Counts and a timestamp
// only. The schema is strict, so nothing else (a cause, a log line, a slug) can ride along with them.

const ok = {
  schemaVersion: 1,
  asOf: '2026-10-18T12:00:00.000Z',
  headline: {
    passing: 40,
    tested: 45,
    failing: 0,
    verifying: 2,
    needsPerson: 1,
    notTested: 3,
    testedAtL3: 3,
    testedAtL2: 36,
    testedAtL1: 6,
    passingAtL3: 3,
    passingAtL2: 33,
    passingAtL1: 4,
  },
  tiers: [
    { tier: 'L3', total: 3, passing: 3, verifying: 0, failing: 0 },
    { tier: 'L2', total: 36, passing: 33, verifying: 2, failing: 1 },
  ],
};

describe('PublicStatusSummary', () => {
  it('accepts the counts of the headline and the tiers', () => {
    expect(PublicStatusSummary.parse(ok)).toEqual(ok);
  });

  it('accepts a site that has not run a cycle yet (no timestamp)', () => {
    expect(PublicStatusSummary.parse({ ...ok, asOf: null }).asOf).toBeNull();
  });

  it('rejects any extra field, at the top, in the headline and in a tier: a cause cannot ride along', () => {
    expect(() =>
      PublicStatusSummary.parse({ ...ok, error: 'TypeError: x is not a function' }),
    ).toThrow();
    expect(() =>
      PublicStatusSummary.parse({ ...ok, headline: { ...ok.headline, slug: 'resend-node' } }),
    ).toThrow();
    expect(() =>
      PublicStatusSummary.parse({
        ...ok,
        tiers: [{ tier: 'L3', total: 1, passing: 1, verifying: 0, failing: 0, proves: 'text' }],
      }),
    ).toThrow();
  });

  it('rejects a negative or fractional count and an unknown tier', () => {
    expect(() =>
      PublicStatusSummary.parse({ ...ok, headline: { ...ok.headline, passing: -1 } }),
    ).toThrow();
    expect(() =>
      PublicStatusSummary.parse({ ...ok, headline: { ...ok.headline, tested: 1.5 } }),
    ).toThrow();
    expect(() =>
      PublicStatusSummary.parse({
        ...ok,
        tiers: [{ tier: 'L9', total: 0, passing: 0, verifying: 0, failing: 0 }],
      }),
    ).toThrow();
  });
});
