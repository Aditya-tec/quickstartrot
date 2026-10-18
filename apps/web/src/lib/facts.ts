import { FREE_TIER, PIPELINE, TARGET_GOAL, TRAFFIC } from '@qsr/core/public';
import { BADGE_CACHE_CONTROL } from './badge';
import { REVALIDATE_SECONDS } from './cache-constants';

// Every number the public pages quote about how QuickstartRot works. The pages build their sentences from FACTS and
// the word helpers below and never type such a number themselves; honesty.test.tsx renders them with these facts
// changed and fails if any figure on a page stayed the same, and a source scan fails on a hard-coded cadence.
// FACTS gets each value from the code that enforces it (PIPELINE in @qsr/core, the cache settings of this app).

const badgeMaxAgeSeconds = Number(/s-maxage=(\d+)/.exec(BADGE_CACHE_CONTROL)?.[1] ?? 0);

export interface Facts {
  cycleHours: number;
  cyclesPerDay: number;
  failuresToOpenIncident: number;
  passesToRecover: number;
  transientStreakToOpenIncident: number;
  transientRetries: number;
  transientRetryDelaySeconds: number;
  crawlRetries: number;
  crawlRetryDelaySeconds: number;
  groundingRetries: number;
  recurrenceWindowDays: number;
  canaryCount: number;
  optOutHours: number;
  disclosureWaitHours: number;
  dataCacheMinutes: number;
  badgeCacheMinutes: number;
  targetTotal: number;
  librariesPercent: number;
  vendorsPercent: number;
  storageTargetMegabytes: number;
  vendorRequestsPerCycle: number;
  vendorRequestsPerDay: number;
}

export const FACTS: Facts = Object.freeze({
  cycleHours: PIPELINE.cycleHours,
  cyclesPerDay: PIPELINE.cyclesPerDay,
  failuresToOpenIncident: PIPELINE.failuresToOpenIncident,
  passesToRecover: PIPELINE.passesToRecover,
  transientStreakToOpenIncident: PIPELINE.transientStreakToOpenIncident,
  transientRetries: PIPELINE.transientRetries,
  transientRetryDelaySeconds: PIPELINE.transientRetryDelaySeconds,
  crawlRetries: PIPELINE.crawlRetries,
  crawlRetryDelaySeconds: PIPELINE.crawlRetryDelaySeconds,
  groundingRetries: PIPELINE.groundingRetries,
  recurrenceWindowDays: PIPELINE.recurrenceWindowDays,
  canaryCount: PIPELINE.canaryCount,
  optOutHours: PIPELINE.optOutHours,
  disclosureWaitHours: PIPELINE.disclosureWaitHours,
  dataCacheMinutes: REVALIDATE_SECONDS / 60,
  badgeCacheMinutes: badgeMaxAgeSeconds / 60,
  targetTotal: TARGET_GOAL.total,
  librariesPercent: TARGET_GOAL.librariesPercent,
  vendorsPercent: TARGET_GOAL.vendorsPercent,
  storageTargetMegabytes: FREE_TIER.storageTargetBytes / (1024 * 1024),
  vendorRequestsPerCycle: TRAFFIC.requestsPerTargetPerCycle,
  vendorRequestsPerDay: TRAFFIC.requestsPerTargetPerDay,
});

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** A small whole number as a word, a larger one as digits. */
export const words = (n: number): string => WORDS[n] ?? String(n);

/** once, twice, three times, 20 times. */
export function timesWord(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${words(n)} times`;
}

const ORDINALS = [
  'zeroth',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];
export const ordinal = (n: number): string => ORDINALS[n] ?? `${n}th`;

export const plural = (n: number, noun: string): string => (n === 1 ? noun : `${noun}s`);
