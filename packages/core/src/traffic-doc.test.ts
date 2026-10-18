import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PIPELINE, TRAFFIC } from './pipeline-facts.js';

// docs/ABOUT-OUR-TRAFFIC.md says the same as the public page. Its figures and names must be the ones in the code.

const doc = readFileSync(
  fileURLToPath(new URL('../../../docs/ABOUT-OUR-TRAFFIC.md', import.meta.url)),
  'utf8',
);
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

describe('docs/ABOUT-OUR-TRAFFIC.md', () => {
  it('names every service that gets a request, and only says so about those', () => {
    for (const s of TRAFFIC.services) expect(doc).toContain(s.name);
  });

  it('quotes the per-cycle and per-day maximum and the cadence from the code', () => {
    expect(doc).toMatch(/at most \*\*one request per cycle\*\*/i);
    expect(TRAFFIC.requestsPerTargetPerCycle).toBe(1);
    expect(doc).toContain(
      `**at most ${WORDS[TRAFFIC.requestsPerTargetPerDay]} a day for each quickstart**`,
    );
    expect(doc).toContain(`every ${WORDS[PIPELINE.cycleHours]} hours`);
  });

  it('says when the terms were read, and that it was a summary and not legal advice', () => {
    expect(TRAFFIC.termsReviewedOn).toBe('2026-10-18');
    expect(doc).toContain('18 October 2026');
    expect(doc).toMatch(/summary check by us, it is not legal advice/);
    expect(doc).toMatch(new RegExp(`within ${PIPELINE.optOutHours} hours`));
  });

  it('claims no affiliation with or endorsement by a service', () => {
    expect(doc).toMatch(/no affiliation with, or endorsement by/);
  });
});
