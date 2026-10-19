import { FACTS, plural, words } from './facts';

const agree = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// What the home page says about itself, in one place: the hero, the page title, the meta description and the share card all read it.
// A pass at level 2 proves a quickstart installs, its code builds and its imports resolve; it was not run against the vendor. Only level 3
// reaches the vendor's API. So the page says "pass their checks", never that a quickstart "works", and it says how far each check goes.
// The numbers come from the data (never typed here); the cadence comes from the pipeline constant the cron is pinned to.

export interface HomeCopyInput {
  passing: number;
  tested: number;
  testedAtL3: number;
  testedAtL2: number;
  testedAtL1: number;
  cycleHours: number;
}

export interface HomeCopy {
  title: string;
  /** "58 of 58": the figure the hero sets in large type. */
  lead: string;
  rest: string;
  /** The line under it: how often, and how far each check goes. */
  detail: string;
}

const SITE = 'QuickstartRot';

/** Static page metadata: no figure in it, so it can never be out of date. */
export const HOME_META = Object.freeze({
  title: `${SITE}: developer quickstarts, tested on a fresh machine`,
  description: `Developer quickstarts, installed and tested on a fresh machine about every ${words(FACTS.cycleHours)} ${plural(FACTS.cycleHours, 'hour')}, with the logs and the docs diff as evidence. A pass means the quickstart installs, its code builds and its imports resolve; only some reach the vendor's API.`,
});

export function homeCopy(i: HomeCopyInput): HomeCopy {
  const title = HOME_META.title;
  if (i.tested === 0)
    return { title, lead: 'No quickstarts', rest: 'have been tested yet', detail: '' };
  const parts = [
    i.testedAtL3 > 0
      ? `${i.testedAtL3} ${agree(i.testedAtL3, 'reaches', 'reach')} the vendor's API`
      : null,
    i.testedAtL2 > 0
      ? `${i.testedAtL2} ${agree(i.testedAtL2, 'stops', 'stop')} at install, build and imports`
      : null,
    i.testedAtL1 > 0 ? `${i.testedAtL1} ${agree(i.testedAtL1, 'stops', 'stop')} at install` : null,
  ].filter((p): p is string => p !== null);
  return {
    title,
    lead: `${i.passing} of ${i.tested}`,
    rest: `quickstart${i.tested === 1 ? '' : 's'} pass${i.tested === 1 ? 'es' : ''} ${i.tested === 1 ? 'its' : 'their'} checks today`,
    detail: `Installed and tested on a fresh machine about every ${words(i.cycleHours)} ${plural(i.cycleHours, 'hour')}.${parts.length > 0 ? ` ${parts.join('; ')}.` : ''}`,
  };
}
