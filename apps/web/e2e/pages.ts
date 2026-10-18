import { FIXTURE_SLUGS, FixtureDataSource } from '../src/lib/data/fixtures';

// Every page the tests visit: axe, screenshots and the leak check all use this one list.

export interface PageSpec {
  name: string;
  path: string;
}

const source = new FixtureDataSource();
const tools = await source.listTools();
const runOf = (slug: string): string => {
  const id = tools.find((t) => t.slug === slug)?.last_run_id;
  if (!id) throw new Error(`fixture tool ${slug} has no last run`);
  return id;
};

export const RUN_IDS = {
  failing: runOf(FIXTURE_SLUGS.failing),
  verifying: runOf(FIXTURE_SLUGS.verifying),
  stale: runOf(FIXTURE_SLUGS.stale),
  healthy: runOf(FIXTURE_SLUGS.healthy),
  needsPerson: runOf(FIXTURE_SLUGS.needsPerson),
};

export const PAGES: PageSpec[] = [
  { name: 'home', path: '/' },
  { name: 'home-filtered', path: '/?lang=python&sort=name&dir=asc' },
  { name: 'tool-failing', path: `/tools/${FIXTURE_SLUGS.failing}` },
  { name: 'tool-verifying', path: `/tools/${FIXTURE_SLUGS.verifying}` },
  { name: 'tool-healthy', path: `/tools/${FIXTURE_SLUGS.healthy}` },
  { name: 'tool-l2', path: `/tools/${FIXTURE_SLUGS.l2}` },
  { name: 'tool-stale', path: `/tools/${FIXTURE_SLUGS.stale}` },
  { name: 'tool-needs-person', path: `/tools/${FIXTURE_SLUGS.needsPerson}` },
  { name: 'tool-unknown', path: `/tools/${FIXTURE_SLUGS.unknown}` },
  { name: 'tool-long-name', path: `/tools/${FIXTURE_SLUGS.longName}` },
  { name: 'tool-many-runs', path: `/tools/${FIXTURE_SLUGS.manyRuns}` },
  { name: 'tool-opted-out', path: `/tools/${FIXTURE_SLUGS.optedOut}` },
  { name: 'tool-history-hidden', path: `/tools/${FIXTURE_SLUGS.historyHidden}` },
  { name: 'run-failing', path: `/runs/${RUN_IDS.failing}` },
  { name: 'run-verifying', path: `/runs/${RUN_IDS.verifying}` },
  { name: 'run-stale', path: `/runs/${RUN_IDS.stale}` },
  { name: 'incidents', path: '/incidents' },
  { name: 'methodology', path: '/methodology' },
  { name: 'bot', path: '/bot' },
  { name: 'submit', path: '/submit' },
  { name: 'admin-login', path: '/admin/login' },
  { name: 'not-found', path: '/tools/not-a-tracked-tool' },
];

export { FIXTURE_SLUGS };
