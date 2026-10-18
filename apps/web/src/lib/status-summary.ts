import { PublicStatusSummary } from '@qsr/core/public';
import { tierBreakdown } from './headline';
import type { HomeModel } from './model';

/**
 * The counts behind the home headline, for GET /api/status. Built from the same model as the page, then parsed with the strict
 * public schema, so only counts and a timestamp can leave (no name, slug, cause or text).
 */
export function buildStatusSummary(home: HomeModel): PublicStatusSummary {
  return PublicStatusSummary.parse({
    schemaVersion: 1,
    asOf: home.asOf,
    headline: home.headline,
    tiers: tierBreakdown(home.tested).map((t) => ({
      tier: t.tier,
      total: t.total,
      passing: t.passing,
      verifying: t.verifying,
      failing: t.failing,
    })),
  });
}
