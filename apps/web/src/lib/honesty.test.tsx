import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { BotContent } from '@/components/bot-content';
import { Headline } from '@/components/headline';
import { MethodologyContent } from '@/components/methodology-content';
import { FACTS, type Facts } from './facts';

// The public pages must not claim a number that differs from the code. The pages are built from FACTS (which are
// the constants the pipeline uses). This test renders each page twice: with the real facts, and with EVERY fact
// changed. Any figure that is the same in both renderings was typed by hand, not derived: it has no business on
// the page unless it is one of the few listed as allowed below. So a claim about a retry count, a threshold, a
// window or a cadence cannot drift from the code, and a hard-coded one fails here.

/** Every fact changed to a value no real figure on a page could equal. */
function changed(facts: Facts): Facts {
  const out: Record<string, number> = {};
  Object.entries(facts).forEach(([key, value], i) => (out[key] = value + 101 + i * 3));
  return out as unknown as Facts;
}

const text = (element: ReactElement): string =>
  renderToStaticMarkup(element)
    .replaceAll(/<script[\s\S]*?<\/script>/g, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll(/&[a-z]+;|&#\d+;/gi, ' ')
    .replaceAll(/\s+/g, ' ');

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|once|twice|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|half|dozen';

/** The figures in a text: digits and number words. "Level 3" and the bot's own version are definitions, not claims. */
function figures(page: string): string[] {
  const cleaned = page
    .replaceAll(/\bLevel \d\b/gi, ' ')
    .replaceAll(/QuickstartRotBot\/\d+\.\d+/g, ' ');
  return (
    cleaned.match(new RegExp(`\\b\\d+(?:\\.\\d+)?%?|\\b(?:${NUMBER_WORDS})\\b`, 'gi')) ?? []
  ).map((f) => f.toLowerCase());
}

/** Figures present, with the same count, in both renderings: not derived from any fact. */
function handTyped(real: string, other: string): string[] {
  const count = (list: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const f of list) m.set(f, (m.get(f) ?? 0) + 1);
    return m;
  };
  const a = count(figures(real));
  const b = count(figures(other));
  return [...a.entries()].filter(([f, n]) => b.get(f) === n).map(([f]) => f);
}

const HEADLINE_FIXTURE = {
  headline: {
    passing: 6,
    tested: 8,
    failing: 1,
    verifying: 1,
    needsPerson: 1,
    notTested: 1,
    testedAtL3: 5,
    testedAtL2: 3,
    testedAtL1: 0,
    passingAtL3: 4,
    passingAtL2: 2,
    passingAtL1: 0,
  },
  tested: [],
  asOf: '2026-10-17T12:00:00.000Z',
};

const PAGES: {
  name: string;
  render: (facts: Facts) => ReactElement;
  allowed: string[];
  uses: (keyof Facts)[];
}[] = [
  {
    name: '/methodology',
    render: (facts) => <MethodologyContent facts={facts} />,
    // none: every figure on the page comes from a fact
    allowed: [],
    uses: [
      'cycleHours',
      'failuresToOpenIncident',
      'passesToRecover',
      'transientStreakToOpenIncident',
      'transientRetries',
      'transientRetryDelaySeconds',
      'crawlRetries',
      'crawlRetryDelaySeconds',
      'groundingRetries',
      'recurrenceWindowDays',
      'canaryCount',
      'optOutHours',
      'vendorReplyBusinessDays',
      'disclosureWaitHours',
      'dataCacheMinutes',
      'badgeCacheMinutes',
      'targetTotal',
      'librariesPercent',
      'vendorsPercent',
    ],
  },
  {
    name: '/bot',
    render: (facts) => (
      <BotContent
        facts={facts}
        userAgent="QuickstartRotBot/1.0 (+https://example.test/bot)"
        email={null}
        traffic={{ services: [{ name: 'Alpha' }], termsReviewedOn: '2026-10-18' }}
      />
    ),
    // the date the terms were read (18 October 2026) is a dated statement, not a figure about how the pipeline runs
    allowed: ['18', '2026'],
    uses: [
      'cycleHours',
      'cyclesPerDay',
      'crawlRetries',
      'crawlRetryDelaySeconds',
      'optOutHours',
      'vendorReplyBusinessDays',
      'vendorRequestsPerCycle',
      'vendorRequestsPerDay',
    ],
  },
  {
    name: 'the home headline',
    render: (facts) => <Headline {...HEADLINE_FIXTURE} facts={facts} />,
    // the data shown (6 of 8, counts by level) is data, not a claim about the pipeline
    allowed: ['6', '8', '1', '5', '3', '4', '2', '0', '17', '12', '00'],
    uses: ['cycleHours'],
  },
];

describe('the public pages quote only figures derived from the code', () => {
  for (const page of PAGES) {
    describe(page.name, () => {
      const real = text(page.render(FACTS));
      const other = text(page.render(changed(FACTS)));

      it('has no hand-typed number: every figure moves when the facts move', () => {
        const stuck = handTyped(real, other).filter((f) => !page.allowed.includes(f));
        expect(stuck, `these figures did not change with the facts: ${stuck.join(', ')}`).toEqual(
          [],
        );
      });

      it.each(page.uses)('quotes %s from the facts', (key) => {
        const mutated = changed(FACTS);
        // the changed value shows up as digits in the other rendering (words only exist for small numbers)
        expect(other, key).toContain(String(mutated[key]));
      });
    });
  }

  it('shows the real numbers in the real rendering (sanity: they are not all hidden)', () => {
    const real = text(<MethodologyContent facts={FACTS} />);
    expect(real).toContain('six hours');
    expect(real).toContain(`${FACTS.optOutHours} hours`);
    expect(real).toContain(`${FACTS.disclosureWaitHours} hours`);
  });
});

describe('no source file types a cadence or a retry count by hand', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'facts.ts'
        ? [full]
        : [];
    });
  const FORBIDDEN = [
    /\bevery (?:six|6|four|4|twelve|12) hours\b/i,
    /\bevery (?:five|5|ten|10) minutes\b/i,
    /\b(?:six|6)[- ]hour(?:ly)?\b/i,
    /\bretried (?:once|twice|\d+ times)\b/i,
    /\bwithin (?:24|48|twenty-four|forty-eight) hours\b/i,
  ];
  it.each(FORBIDDEN.map((re) => [String(re), re] as const))('nothing matches %s', (_name, re) => {
    const offenders = files(ROOT)
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
