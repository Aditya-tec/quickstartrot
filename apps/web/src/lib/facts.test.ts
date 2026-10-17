import { describe, expect, it } from 'vitest';
import { FREE_TIER, PIPELINE, TARGET_GOAL } from '@qsr/core/public';
import { BADGE_CACHE_CONTROL } from './badge';
import { REVALIDATE_SECONDS } from './cache-constants';
import { FACTS, ordinal, plural, timesWord, words } from './facts';

// Every number the public pages quote about the pipeline comes from here, which gets it from the code that enforces
// it (PIPELINE in @qsr/core, the cache settings of this app). Pages never type such a number themselves.

describe('FACTS', () => {
  it('is the pipeline constants and the cache settings, not a copy of them', () => {
    expect(FACTS.cycleHours).toBe(PIPELINE.cycleHours);
    expect(FACTS.cyclesPerDay).toBe(PIPELINE.cyclesPerDay);
    expect(FACTS.failuresToOpenIncident).toBe(PIPELINE.failuresToOpenIncident);
    expect(FACTS.passesToRecover).toBe(PIPELINE.passesToRecover);
    expect(FACTS.transientStreakToOpenIncident).toBe(PIPELINE.transientStreakToOpenIncident);
    expect(FACTS.transientRetries).toBe(PIPELINE.transientRetries);
    expect(FACTS.transientRetryDelaySeconds).toBe(PIPELINE.transientRetryDelaySeconds);
    expect(FACTS.crawlRetries).toBe(PIPELINE.crawlRetries);
    expect(FACTS.crawlRetryDelaySeconds).toBe(PIPELINE.crawlRetryDelaySeconds);
    expect(FACTS.groundingRetries).toBe(PIPELINE.groundingRetries);
    expect(FACTS.recurrenceWindowDays).toBe(PIPELINE.recurrenceWindowDays);
    expect(FACTS.canaryCount).toBe(PIPELINE.canaryCount);
    expect(FACTS.optOutHours).toBe(PIPELINE.optOutHours);
    expect(FACTS.disclosureWaitHours).toBe(PIPELINE.disclosureWaitHours);
    expect(FACTS.targetTotal).toBe(TARGET_GOAL.total);
    expect(FACTS.librariesPercent).toBe(TARGET_GOAL.librariesPercent);
    expect(FACTS.vendorsPercent).toBe(TARGET_GOAL.vendorsPercent);
    expect(FACTS.storageTargetMegabytes).toBe(FREE_TIER.storageTargetBytes / (1024 * 1024));
  });

  it('derives the cache lifetimes from the real cache settings', () => {
    expect(FACTS.dataCacheMinutes).toBe(REVALIDATE_SECONDS / 60);
    const sMaxAge = /s-maxage=(\d+)/.exec(BADGE_CACHE_CONTROL)?.[1];
    expect(FACTS.badgeCacheMinutes).toBe(Number(sMaxAge) / 60);
  });
});

describe('words', () => {
  it.each([
    [0, 'zero'],
    [1, 'one'],
    [4, 'four'],
    [6, 'six'],
    [12, 'twelve'],
  ])('%d -> %s', (n, w) => {
    expect(words(n)).toBe(w);
  });
  it('uses digits where a word would be clumsy', () => {
    expect(words(13)).toBe('13');
    expect(words(24)).toBe('24');
  });
});

describe('timesWord', () => {
  it.each([
    [1, 'once'],
    [2, 'twice'],
    [3, 'three times'],
    [20, '20 times'],
  ])('%d -> %s', (n, w) => {
    expect(timesWord(n)).toBe(w);
  });
});

describe('ordinal and plural', () => {
  it.each([
    [1, 'first'],
    [2, 'second'],
    [3, 'third'],
    [9, 'ninth'],
    [11, '11th'],
  ])('ordinal %d -> %s', (n, w) => {
    expect(ordinal(n)).toBe(w);
  });
  it('plural', () => {
    expect(plural(1, 'minute')).toBe('minute');
    expect(plural(5, 'minute')).toBe('minutes');
    expect(plural(0, 'day')).toBe('days');
  });
});
