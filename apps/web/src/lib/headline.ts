import type { ToolSummary } from './model';

// The headline and its per-level breakdown. A pass at L2 proves the quickstart installs and builds; only L3 shows
// that it reached the vendor's API. So the page never shows one number without saying what it is made of.

export interface Tier {
  tier: 'L3' | 'L2' | 'L1';
  /** What a pass at this level proves, in one sentence. */
  proves: string;
  total: number;
  passing: number;
  verifying: number;
  failing: number;
}

const PROVES: Record<Tier['tier'], string> = {
  L3: "The snippet ran and reached the vendor's API (an auth error with a dummy key counts as a pass).",
  L2: 'The quickstart installs, and its code builds and its imports resolve. It was not run against the vendor.',
  L1: 'The install commands ran. Nothing was built or run.',
};

const tierOf = (level: number): Tier['tier'] => (level >= 3 ? 'L3' : level === 2 ? 'L2' : 'L1');

/** Tested tools only (passing, failing, verifying), grouped by what their test proves, deepest first. */
export function tierBreakdown(tools: readonly ToolSummary[]): Tier[] {
  const rows = new Map<Tier['tier'], Tier>();
  for (const t of tools) {
    if (t.status !== 'passing' && t.status !== 'failing' && t.status !== 'verifying') continue;
    const key = tierOf(t.level);
    const row = rows.get(key) ?? {
      tier: key,
      proves: PROVES[key],
      total: 0,
      passing: 0,
      verifying: 0,
      failing: 0,
    };
    row.total += 1;
    row[t.status] += 1;
    rows.set(key, row);
  }
  return (['L3', 'L2', 'L1'] as const).flatMap((k) => rows.get(k) ?? []);
}
