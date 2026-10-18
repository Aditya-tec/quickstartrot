import { describe, expect, it } from 'vitest';
import { FIXTURE_SLUGS, FixtureDataSource, UNREVIEWED_CAUSE } from './data/fixtures.js';
import {
  loadBadgeStatus,
  loadHome,
  loadIncidentsPage,
  loadKnownSlugs,
  loadOgData,
  loadRunPage,
  loadToolPage,
} from './service.js';

// The loaders are what every page, the badge and the images are built from. These tests run them against the
// fixtures, which include an unreviewed incident and a failing run that CLAIMS its details are published (as if a
// layer below had failed), and assert the unreviewed cause is nowhere in what comes out.

const source = new FixtureDataSource();
const leaks = (value: unknown): boolean => JSON.stringify(value).includes('ZZ-UNREVIEWED');

describe('loadHome', () => {
  it('builds the headline from tested tools only, level-aware, with SKIPPED and never-run tools set apart', async () => {
    const home = await loadHome(source);
    expect(home.headline.tested).toBe(
      home.headline.passing + home.headline.failing + home.headline.verifying,
    );
    expect(home.needsPerson.map((t) => t.slug)).toEqual([FIXTURE_SLUGS.needsPerson]);
    expect(home.notTested.map((t) => t.slug)).toEqual([FIXTURE_SLUGS.unknown]);
    expect(home.tested.map((t) => t.slug)).not.toContain(FIXTURE_SLUGS.needsPerson);
    expect(home.headline.testedAtL3 + home.headline.testedAtL2 + home.headline.testedAtL1).toBe(
      home.headline.tested,
    );
    expect(home.headline.failing).toBe(1);
    expect(home.headline.verifying).toBe(1);
  });

  it('shows the unreviewed tool as verifying, and the confirmed one as failing since the incident date', async () => {
    const home = await loadHome(source);
    const by = (slug: string) => home.tested.find((t) => t.slug === slug);
    expect(by(FIXTURE_SLUGS.verifying)?.status).toBe('verifying');
    expect(by(FIXTURE_SLUGS.failing)?.status).toBe('failing');
    expect(by(FIXTURE_SLUGS.failing)?.failingSince).toBe('2026-10-12T07:00:00.000Z');
  });

  it('gives every tool a strip of at most 28 runs', async () => {
    const home = await loadHome(source);
    for (const t of [...home.tested, ...home.needsPerson, ...home.notTested])
      expect(t.strip.length).toBeLessThanOrEqual(28);
    expect(home.tested.find((t) => t.slug === FIXTURE_SLUGS.manyRuns)?.strip).toHaveLength(28);
  });

  it('SAFETY: contains nothing of the unreviewed cause', async () => {
    expect(leaks(await loadHome(source))).toBe(false);
  });
});

describe('loadToolPage', () => {
  it('a confirmed failing tool: the incident, its diff and version change, the latest run with its cause', async () => {
    const page = await loadToolPage(source, FIXTURE_SLUGS.failing);
    expect(page?.tool.status).toBe('failing');
    expect(page?.openIncident?.summary).toMatch(/Chalk 6\.0/);
    expect(page?.openIncident?.docsDiffPath).toBe('diffs/fixture/chalk-docs.diff');
    expect(page?.openIncident?.versionDiff?.changed[0]).toEqual({
      name: 'chalk',
      from: '5.3.0',
      to: '6.0.0',
    });
    expect(page?.latestRun?.causeVisible).toBe(true);
    expect(page?.latestRun?.failure_class).toBe('API_DRIFT');
    expect(
      page?.latestRun?.steps.some((s) => s.stderr_tail?.includes('chalk.red is not a function')),
    ).toBe(true);
    expect(page?.strip).toHaveLength(40 > 60 ? 60 : 40);
  });

  it('the UNREVIEWED tool is verifying: no incident, no cause, nothing that points at its log or diff', async () => {
    const page = await loadToolPage(source, FIXTURE_SLUGS.verifying);
    expect(page?.tool.status).toBe('verifying');
    expect(page?.openIncident).toBeNull();
    expect(page?.incidents).toEqual([]);
    expect(page?.latestRun?.causeVisible).toBe(false);
    expect(page?.latestRun?.failure_class).toBeNull();
    expect(page?.latestRun?.steps.every((s) => s.log_path === null && s.stderr_tail === null)).toBe(
      true,
    );
    expect(leaks(page)).toBe(false);
    expect(JSON.stringify(page)).not.toContain('fastify-docs.diff');
    expect(JSON.stringify(page)).not.toContain('fastify-fail');
  });

  it('a healthy tool, a needs-a-person tool and a never-run tool each have a page', async () => {
    expect((await loadToolPage(source, FIXTURE_SLUGS.healthy))?.tool.status).toBe('passing');
    expect((await loadToolPage(source, FIXTURE_SLUGS.needsPerson))?.tool.status).toBe(
      'needs_person',
    );
    const unknown = await loadToolPage(source, FIXTURE_SLUGS.unknown);
    expect(unknown?.tool.status).toBe('unknown');
    expect(unknown?.strip).toEqual([]);
    expect(unknown?.latestRun).toBeNull();
  });

  it('the strip has the newest 60 runs, oldest first', async () => {
    const page = await loadToolPage(source, FIXTURE_SLUGS.manyRuns);
    expect(page?.strip).toHaveLength(60);
    expect((page?.strip[0]?.at ?? '') < (page?.strip[59]?.at ?? '')).toBe(true);
  });

  it('a resolved confirmed incident is history, not an open incident', async () => {
    const page = await loadToolPage(source, FIXTURE_SLUGS.healthy);
    expect(page?.openIncident).toBeNull();
    expect(page?.incidents).toHaveLength(1);
    expect(page?.incidents[0]?.state).toBe('RESOLVED');
  });

  it('is null for a slug that is not tracked, and for a malformed one', async () => {
    expect(await loadToolPage(source, 'not-a-tool')).toBeNull();
    expect(await loadToolPage(source, '../etc/passwd')).toBeNull();
    expect(await loadToolPage(source, '<script>')).toBeNull();
  });

  it('SAFETY: no tool page contains the unreviewed cause', async () => {
    for (const t of await source.listTools())
      expect(leaks(await loadToolPage(source, t.slug)), t.slug).toBe(false);
  });
});

describe('loadRunPage', () => {
  it('opens a run of the confirmed tool with its cause, plan, steps and environment', async () => {
    const tool = (await source.listTools()).find((t) => t.slug === FIXTURE_SLUGS.failing);
    const page = await loadRunPage(source, tool?.last_run_id as string);
    expect(page?.run.causeVisible).toBe(true);
    expect(page?.toolName).toBe('Chalk');
    expect(page?.run.plan_ir?.steps.length).toBeGreaterThan(1);
    expect(page?.run.runner_env['node']).toBe('v22.11.0');
  });

  it('a failing run of the UNREVIEWED tool opens, but with its cause removed', async () => {
    const history = await source.listToolHistory(FIXTURE_SLUGS.verifying, 60);
    const failing = history.find((h) => h.kind === 'fail');
    const page = await loadRunPage(source, failing?.run_id as string);
    expect(page?.run.outcome).toBe('FAIL');
    expect(page?.run.causeVisible).toBe(false);
    expect(leaks(page)).toBe(false);
  });

  it('SAFETY: no run page of any tool, in any state, contains the unreviewed cause', async () => {
    const all = await source.listHistory(5);
    for (const h of all) expect(leaks(await loadRunPage(source, h.run_id)), h.run_id).toBe(false);
  });

  it('is null for an unknown id and for something that is not an id', async () => {
    expect(await loadRunPage(source, '00000000-0000-4000-8000-ffffffffffff')).toBeNull();
    expect(await loadRunPage(source, 'nope')).toBeNull();
    expect(await loadRunPage(source, "1' or '1'='1")).toBeNull();
  });
});

describe('loadIncidentsPage', () => {
  it('lists confirmed incidents only, newest first', async () => {
    const list = await loadIncidentsPage(source);
    expect(list.map((i) => i.toolSlug)).toEqual([FIXTURE_SLUGS.failing, FIXTURE_SLUGS.healthy]);
    expect(leaks(list)).toBe(false);
  });
});

describe('loadBadgeStatus and loadOgData', () => {
  it.each([
    [FIXTURE_SLUGS.healthy, 'passing'],
    [FIXTURE_SLUGS.failing, 'failing'],
    [FIXTURE_SLUGS.verifying, 'verifying'],
    [FIXTURE_SLUGS.unknown, 'unknown'],
    [FIXTURE_SLUGS.needsPerson, 'needs_person'],
    ['not-a-tool', 'not_tracked'],
    ['Not A Slug!', 'not_tracked'],
  ])('%s -> %s', async (slug, status) => {
    expect(await loadBadgeStatus(source, slug)).toBe(status);
  });

  it('the image data of a confirmed tool has the error line; an unreviewed tool has none', async () => {
    const failing = await loadOgData(source, FIXTURE_SLUGS.failing);
    expect(failing).toMatchObject({
      name: 'Chalk',
      status: 'failing',
      failingSince: '2026-10-12T07:00:00.000Z',
    });
    expect(failing?.errorLine).toBe('TypeError: chalk.red is not a function');
    const verifying = await loadOgData(source, FIXTURE_SLUGS.verifying);
    expect(verifying?.status).toBe('verifying');
    expect(verifying?.errorLine).toBeNull();
    expect(leaks(verifying)).toBe(false);
  });

  it('there is no image data for a tool we do not track', async () => {
    expect(await loadOgData(source, 'not-a-tool')).toBeNull();
  });

  it('the cause string exists in the raw fixtures but in no loader output', async () => {
    expect(JSON.stringify(await source.listIncidents())).toContain(UNREVIEWED_CAUSE);
    for (const slug of Object.values(FIXTURE_SLUGS)) {
      expect(leaks(await loadOgData(source, slug)), slug).toBe(false);
      expect(await loadBadgeStatus(source, slug)).not.toContain('ZZ');
    }
  });
});

describe('loadKnownSlugs', () => {
  // The badge, the image and the tool page check a slug against this list before they look anything up, so a slug nobody tracks costs no
  // query and no cache entry of its own.
  it('lists the tracked slugs, sorted, and nothing else', async () => {
    const slugs = await loadKnownSlugs(source);
    const tools = await source.listTools();
    expect(slugs).toEqual(tools.map((t) => t.slug).sort());
    expect(slugs).toContain(FIXTURE_SLUGS.healthy);
    expect(slugs).not.toContain('some-made-up-slug');
    expect(JSON.stringify(slugs)).not.toContain('ZZ-UNREVIEWED');
  });
});
