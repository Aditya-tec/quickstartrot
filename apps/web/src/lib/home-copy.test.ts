import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { numbersIn } from '@qsr/core/public';
import { FACTS } from './facts';
import { homeCopy, HOME_META, type HomeCopyInput } from './home-copy';

// One source for what the home page says about itself: the hero, the meta description and the share card all come from home-copy.ts.
// A pass at level 2 proves a quickstart installs, builds and resolves its imports; only level 3 reaches the vendor. So nothing here may
// claim that a quickstart "works", and every number must be one the claims sheet (docs/CLAIMS.md) has.

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const input = (over: Partial<HomeCopyInput> = {}): HomeCopyInput => ({
  passing: 58,
  tested: 58,
  testedAtL3: 3,
  testedAtL2: 55,
  testedAtL1: 0,
  cycleHours: 6,
  ...over,
});
const CLAIM = /\bwork(s|ing)?\b/i;

describe('homeCopy', () => {
  it('says what the data supports, in the approved methodology wording', () => {
    expect(homeCopy(input())).toMatchObject({
      lead: '58 of 58',
      rest: 'quickstarts pass their checks today',
      detail:
        "Installed and tested on a fresh machine about every six hours. 3 reach the vendor's API; 55 stop at install, build and imports.",
    });
  });

  it('agrees in number, and leaves out a level nobody is at', () => {
    expect(homeCopy(input({ passing: 1, tested: 1, testedAtL3: 1, testedAtL2: 0 }))).toMatchObject({
      rest: 'quickstart passes its checks today',
      detail:
        "Installed and tested on a fresh machine about every six hours. 1 reaches the vendor's API.",
    });
    expect(homeCopy(input({ testedAtL3: 0, testedAtL2: 50, testedAtL1: 8 })).detail).toBe(
      'Installed and tested on a fresh machine about every six hours. 50 stop at install, build and imports; 8 stop at install.',
    );
  });

  it('has nothing to claim before anything is tested', () => {
    expect(homeCopy(input({ passing: 0, tested: 0, testedAtL3: 0, testedAtL2: 0 }))).toMatchObject({
      lead: 'No quickstarts',
      rest: 'have been tested yet',
    });
  });

  it('takes the cadence from the pipeline constant the cron is pinned to, as words', () => {
    expect(homeCopy(input({ cycleHours: FACTS.cycleHours })).detail).toContain(
      'about every six hours',
    );
    expect(homeCopy(input({ cycleHours: 12 })).detail).toContain('about every twelve hours');
  });
});

describe('the home page never claims a quickstart "works"', () => {
  const strings = (): string[] => {
    const c = homeCopy(input());
    return [c.title, c.lead, c.rest, c.detail, HOME_META.title, HOME_META.description];
  };

  it('the hero, the title, the meta description and the share card text do not say work, works or working', () => {
    for (const s of strings()) expect(s, s).not.toMatch(CLAIM);
  });

  it('the pages that build them take the text from home-copy.ts and type no claim of their own', () => {
    for (const rel of [
      'apps/web/src/app/layout.tsx',
      'apps/web/src/lib/og-image.tsx',
      'apps/web/src/components/headline.tsx',
    ])
      expect(read(rel), rel).toContain(
        "lib/home-copy'".replace('lib/', rel.includes('og-image') ? './' : '@/lib/'),
      );
    for (const rel of ['apps/web/src/app/layout.tsx', 'apps/web/src/lib/og-image.tsx'])
      expect(read(rel), rel).not.toMatch(/still work|work on a fresh|quickstart work/i);
  });
});

describe('every number it can print is in docs/CLAIMS.md', () => {
  const sheet = read('docs/CLAIMS.md');
  const cell = (id: string): string =>
    (
      sheet
        .split('\n')
        .find((l) => l.includes(`\`status.${id}\``))
        ?.split('|')[3] ?? ''
    ).trim();
  const int = (id: string): number => Number(/\d+/.exec(cell(id))?.[0]);

  it("with the sheet's own figures, the text contains no other number", () => {
    const c = homeCopy({
      passing: int('passing'),
      tested: Number(/of (\d+)/.exec(cell('passing'))?.[1]),
      testedAtL3: int('testedAtL3'),
      testedAtL2: int('testedAtL2'),
      testedAtL1: int('testedAtL1'),
      cycleHours: FACTS.cycleHours,
    });
    const allowed = numbersIn(sheet);
    const printed = numbersIn([c.lead, c.rest, c.detail, c.title].join(' '));
    expect(printed.size).toBeGreaterThan(2);
    for (const n of printed) expect(allowed.has(n), `${n} is not in docs/CLAIMS.md`).toBe(true);
  });

  it('the meta description has no digit at all', () => {
    expect(HOME_META.description).not.toMatch(/\d/);
  });
});
