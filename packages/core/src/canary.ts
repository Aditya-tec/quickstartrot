import { hashJson } from './canonical.js';
import type { FailureClass, RunOutcome } from './taxonomy.js';
import type { Target } from './target.js';

// Spec sections 6 and 10. The canaries are fixture tools whose outcome is known in advance. If any of them
// misbehaves (or is missing) the HARNESS is suspect, so the cycle is invalid and nothing it saw may move a
// vendor's status. This table is the single source: the CLI, the API and targets/_canary/canaries.json
// (checked by a test) must agree with it.

export const CANARY_SLUGS = [
  'canary-pass-node',
  'canary-pass-python',
  'canary-fail-drift',
  'canary-fail-dep',
] as const;
export type CanarySlug = (typeof CANARY_SLUGS)[number];

export const CANARY_EXPECTATIONS: Record<
  CanarySlug,
  { outcome: 'PASS' | 'FAIL'; failureClass: FailureClass | null }
> = {
  'canary-pass-node': { outcome: 'PASS', failureClass: null },
  'canary-pass-python': { outcome: 'PASS', failureClass: null },
  'canary-fail-drift': { outcome: 'FAIL', failureClass: 'API_DRIFT' },
  'canary-fail-dep': { outcome: 'FAIL', failureClass: 'DEPENDENCY_RESOLUTION' },
};

export const isCanarySlug = (slug: string): boolean => slug.startsWith('canary-');

export interface CanaryObservation {
  slug: string;
  /** The final attempt's outcome. */
  outcome: RunOutcome;
  failureClass: FailureClass | null;
}

const describeResult = (outcome: string, failureClass: FailureClass | null): string =>
  failureClass === null ? outcome : `${outcome} (${failureClass})`;

/** Every canary must be present and give its expected outcome AND class. Pure. */
export function checkCanaries(observations: readonly CanaryObservation[]): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  for (const slug of CANARY_SLUGS) {
    const want = CANARY_EXPECTATIONS[slug];
    const got = observations.find((o) => o.slug === slug);
    if (!got) {
      problems.push(`${slug}: no result in this cycle`);
      continue;
    }
    if (got.outcome !== want.outcome || got.failureClass !== want.failureClass) {
      problems.push(
        `${slug}: expected ${describeResult(want.outcome, want.failureClass)} but got ${describeResult(got.outcome, got.failureClass)}`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Hash of the target fields that change a compiled plan: what the model is told (placeholders, level,
 * language) and what the crawler keeps (extract.variants). Editing the name, notes, owners, URL or timeouts
 * must NOT recompile, so none of those are in it. Part of the plan cache key (migration 0003).
 */
export function compileConfigHash(target: Target): string {
  const relevant = {
    placeholders: target.placeholders,
    level: target.level,
    language: target.language,
    variants: target.extract.variants ?? null,
  };
  return hashJson(relevant);
}

/**
 * The canary every shard runs (spec section 12), so each runner machine proves itself before its tools'
 * results are trusted. The other canaries run in shard 0 only.
 */
export const GUARD_CANARY = 'canary-pass-node';
