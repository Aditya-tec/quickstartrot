import { z } from 'zod';

// GET /api/status on the website: the counts behind the home headline, as JSON, for the README table and the launch check (the README
// must say what the site says). Counts and a timestamp only: the schema is strict, so a cause, a log line or a slug cannot be added to it
// by accident. It is the same data the home page shows, from the same loader, so it carries the same "verifying" for an unreviewed failure.
// Browser-safe: zod only.

const Count = z.number().int().min(0);

export const PublicStatusSummary = z.strictObject({
  schemaVersion: z.literal(1),
  /** When the data was current (the newest run), or null before the first cycle. */
  asOf: z.string().nullable(),
  headline: z.strictObject({
    passing: Count,
    tested: Count,
    failing: Count,
    verifying: Count,
    needsPerson: Count,
    notTested: Count,
    testedAtL3: Count,
    testedAtL2: Count,
    testedAtL1: Count,
    passingAtL3: Count,
    passingAtL2: Count,
    passingAtL1: Count,
  }),
  /** Tested quickstarts by the level their test reached, deepest first. */
  tiers: z.array(
    z.strictObject({
      tier: z.enum(['L3', 'L2', 'L1']),
      total: Count,
      passing: Count,
      verifying: Count,
      failing: Count,
    }),
  ),
});
export type PublicStatusSummary = z.infer<typeof PublicStatusSummary>;
