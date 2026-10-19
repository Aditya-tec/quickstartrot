import { describe, expect, it } from 'vitest';
import { CANARY_SLUGS } from './canary.js';
import {
  OPT_OUT,
  optOutSentences,
  PIPELINE,
  PROBATION,
  TARGET_GOAL,
  TRAFFIC,
} from './pipeline-facts.js';
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

  // The owner's decision of 2026-10-18: probing stops within a day of an opt-out request; a written reply within three business days.
  it('promises a vendor that probing stops within 24 hours of an opt-out request and a written reply within 3 business days', () => {
    expect(PIPELINE.optOutHours).toBe(24);
    expect(PIPELINE.vendorReplyBusinessDays).toBe(3);
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

// What happens when a vendor opts out (the owner's decision of 2026-10-19): probing stops within 24 hours; the vendor's page stays up, labelled
// "no longer monitored at the vendor's request"; past results stay visible and are hidden only on request. One definition: the site, the README,
// the vendor form, the docs and the email template all say exactly this, each generated from it or tested against it.
describe('OPT_OUT', () => {
  it('has the label the vendor’s page carries', () => {
    expect(OPT_OUT.pageLabel).toBe("No longer monitored at the vendor's request");
  });

  it('has a short form for the badge, which has room for a few words only', () => {
    expect(OPT_OUT.badgeValue).toBe('no longer monitored');
    expect(OPT_OUT.pageLabel.toLowerCase()).toContain(OPT_OUT.badgeValue);
  });

  it('says the three things, in the words every page, form and document uses', () => {
    expect(optOutSentences()).toEqual({
      probing: 'Probing stops within 24 hours of an opt-out request.',
      label:
        'The quickstart\'s page stays up, labelled "no longer monitored at the vendor\'s request".',
      history: 'Past results stay visible and are hidden only if the vendor asks for that.',
    });
  });

  it('takes the hours from the pipeline constant, and a page can pass its own to prove it quotes them', () => {
    expect(optOutSentences().probing).toContain(`${PIPELINE.optOutHours} hours`);
    expect(optOutSentences(77).probing).toBe(
      'Probing stops within 77 hours of an opt-out request.',
    );
  });

  it('is read-only', () => {
    expect(Object.isFrozen(OPT_OUT)).toBe(true);
  });
});

describe('PROBATION', () => {
  it('is two valid cycles, and read-only', () => {
    expect(PROBATION.validCycles).toBe(2);
    expect(Object.isFrozen(PROBATION)).toBe(true);
  });
});
