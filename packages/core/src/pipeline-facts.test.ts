import { describe, expect, it } from 'vitest';
import { CANARY_SLUGS } from './canary.js';
import { PIPELINE, TARGET_GOAL, TRAFFIC } from './pipeline-facts.js';
import { PASSES_TO_RECOVER, RECURRENCE_WINDOW_DAYS, TRANSIENT_INCIDENT_STREAK } from './status.js';

// The numbers the pipeline really uses, in one place. The public methodology page is built from this object, so a
// claim on the page cannot drift from the code. Each of these is also pinned to the code that enforces it by a
// test in that package (the crawler, the executor, the status engine, the API, the workflows).

describe('PIPELINE', () => {
  it('reuses the constants the status engine itself uses', () => {
    expect(PIPELINE.passesToRecover).toBe(PASSES_TO_RECOVER);
    expect(PIPELINE.transientStreakToOpenIncident).toBe(TRANSIENT_INCIDENT_STREAK);
    expect(PIPELINE.recurrenceWindowDays).toBe(RECURRENCE_WINDOW_DAYS);
  });

  it('counts the canaries that exist', () => {
    expect(PIPELINE.canaryCount).toBe(CANARY_SLUGS.length);
  });

  it('has a cadence that divides the day', () => {
    expect(24 % PIPELINE.cycleHours).toBe(0);
    expect(PIPELINE.cyclesPerDay).toBe(24 / PIPELINE.cycleHours);
  });

  it('is read-only', () => {
    expect(Object.isFrozen(PIPELINE)).toBe(true);
    expect(() => {
      (PIPELINE as { cycleHours: number }).cycleHours = 1;
    }).toThrow();
  });

  it('keeps every value a positive whole number', () => {
    for (const [key, value] of Object.entries(PIPELINE)) {
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
  });
});

describe('TARGET_GOAL', () => {
  it('splits the aim between libraries and vendor SDKs, and adds up', () => {
    expect(TARGET_GOAL.librariesPercent + TARGET_GOAL.vendorsPercent).toBe(100);
    expect(TARGET_GOAL.total).toBeGreaterThan(0);
  });
});

describe('TRAFFIC (what we send to the services we test)', () => {
  it('is at most one request per quickstart per cycle, which is the cycles in a day per day', () => {
    expect(TRAFFIC.requestsPerTargetPerCycle).toBe(1);
    expect(TRAFFIC.requestsPerTargetPerDay).toBe(
      PIPELINE.cyclesPerDay * TRAFFIC.requestsPerTargetPerCycle,
    );
  });

  it('names each service once, with the quickstarts behind it, and says when the terms were read', () => {
    const names = TRAFFIC.services.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    const targets = TRAFFIC.services.flatMap((x) => x.targets);
    expect(new Set(targets).size).toBe(targets.length);
    for (const t of targets) expect(t).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(TRAFFIC.termsReviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
