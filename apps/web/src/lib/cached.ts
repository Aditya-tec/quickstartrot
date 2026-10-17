import { unstable_cache } from 'next/cache';
import { REVALIDATE_SECONDS } from './cache-constants';
import { getDataSource } from './data';
import {
  loadBadgeStatus,
  loadHome,
  loadIncidentsPage,
  loadOgData,
  loadRunPage,
  loadToolPage,
} from './service';

// Next 15 does not cache fetch by default, so caching is explicit: every loader is wrapped in unstable_cache with
// a 5-minute revalidate and one tag. POST /api/revalidate (called by the API at the end of each probe cycle)
// invalidates the tag, so a finished cycle shows up at once; otherwise a page is at most 5 minutes old.

export const DATA_TAG = 'qsr-data';
export { REVALIDATE_SECONDS };
const options = { revalidate: REVALIDATE_SECONDS, tags: [DATA_TAG] };

export const getHome = unstable_cache(() => loadHome(getDataSource()), ['qsr-home'], options);
export const getToolPage = unstable_cache(
  (slug: string) => loadToolPage(getDataSource(), slug),
  ['qsr-tool'],
  options,
);
export const getRunPage = unstable_cache(
  (id: string) => loadRunPage(getDataSource(), id),
  ['qsr-run'],
  options,
);
export const getIncidents = unstable_cache(
  () => loadIncidentsPage(getDataSource()),
  ['qsr-incidents'],
  options,
);
export const getBadgeStatus = unstable_cache(
  (slug: string) => loadBadgeStatus(getDataSource(), slug),
  ['qsr-badge'],
  options,
);
export const getOgData = unstable_cache(
  (slug: string) => loadOgData(getDataSource(), slug),
  ['qsr-og'],
  options,
);
