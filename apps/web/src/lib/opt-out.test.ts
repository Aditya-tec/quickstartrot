import { describe, expect, it } from 'vitest';
import { OPT_OUT, PublicToolRow } from '@qsr/core/public';
import { badgeFor } from './badge.js';
import { FIXTURE_SLUGS, FixtureDataSource, HIDDEN_HISTORY_MARKER } from './data/fixtures.js';
import { buildHomeModel, buildToolSummaries } from './model.js';
import { ogCard } from './og.js';
import {
  loadBadgeStatus,
  loadHome,
  loadIncidentsPage,
  loadKnownSlugs,
  loadOgData,
  loadRunPage,
  loadToolPage,
} from './service.js';

// A vendor opts out (owner decision 2026-10-19): the page stays up labelled "no longer monitored at the vendor's request", the tool leaves the
// headline and the tables, past results stay visible, and they are hidden only when the vendor asks. The fixtures include a tool whose
// history is hidden AND rows below it that were not removed (as if the view had failed), so these tests prove the site hides them itself.

const source = new FixtureDataSource();
const kept = FIXTURE_SLUGS.optedOut;
const hidden = FIXTURE_SLUGS.historyHidden;

describe('the fixtures', () => {
  it('have a tool that opted out with its history visible, and one whose history is hidden, with rows that should not exist', async () => {
    const tools = await source.listTools();
    const keptRow = tools.find((t) => t.slug === kept);
    const hiddenRow = tools.find((t) => t.slug === hidden);
    expect(keptRow?.opted_out_at).not.toBeNull();
    expect(keptRow?.history_hidden).toBe(false);
    expect(keptRow?.last_run_id).not.toBeNull();
    expect(hiddenRow?.opted_out_at).not.toBeNull();
    expect(hiddenRow?.history_hidden).toBe(true);
    expect(hiddenRow?.last_run_id).toBeNull();
    // the poison: runs and a confirmed incident of the hidden tool are still in the "database"
    expect((await source.listToolHistory(hidden, 60)).length).toBeGreaterThan(0);
    expect(JSON.stringify(await source.listIncidents())).toContain(HIDDEN_HISTORY_MARKER);
  });
});

describe('the view model', () => {
  it('carries the opt-out date and the hidden flag, and a hidden tool has a zero streak', async () => {
    const tools = await source.listTools();
    const summaries = buildToolSummaries(
      tools.filter((t) => t.slug === kept || t.slug === hidden),
      [],
      [],
    );
    const k = summaries.find((s) => s.slug === kept);
    const h = summaries.find((s) => s.slug === hidden);
    expect(k).toMatchObject({ historyHidden: false });
    expect(k?.optedOutAt).toEqual(expect.any(String));
    expect(h).toMatchObject({ historyHidden: true, status: 'unknown', streak: { count: 0 } });
    expect(h?.optedOutAt).toEqual(expect.any(String));
  });

  it('a tool that did not opt out has neither', async () => {
    const [plain] = buildToolSummaries(
      (await source.listTools()).filter((t) => t.slug === FIXTURE_SLUGS.healthy),
      [],
      [],
    );
    expect(plain).toMatchObject({ optedOutAt: null, historyHidden: false });
  });

  it('buildHomeModel sets opted-out tools apart: not tested, not needing a person, not in the headline', async () => {
    const tools = await source.listTools();
    const withThem = buildHomeModel(buildToolSummaries(tools, [], []));
    const without = buildHomeModel(
      buildToolSummaries(
        tools.filter((t) => t.slug !== kept && t.slug !== hidden),
        [],
        [],
      ),
    );
    expect(withThem.optedOut.map((t) => t.slug).sort()).toEqual([hidden, kept].sort());
    expect(withThem.headline).toEqual(without.headline);
    for (const list of [withThem.tested, withThem.needsPerson, withThem.notTested])
      expect(list.map((t) => t.slug)).not.toEqual(expect.arrayContaining([kept]));
    expect(withThem.tested.map((t) => t.slug)).not.toContain(kept);
    expect(withThem.notTested.map((t) => t.slug)).not.toContain(hidden);
  });
});

describe('loadHome', () => {
  it('lists them apart from the tables and the headline', async () => {
    const home = await loadHome(source);
    expect(home.optedOut.map((t) => t.slug).sort()).toEqual([hidden, kept].sort());
    expect(home.tested.map((t) => t.slug)).not.toContain(kept);
    expect(JSON.stringify(home)).not.toContain(HIDDEN_HISTORY_MARKER);
  });
});

describe('loadToolPage', () => {
  it('an opted-out tool keeps its past results: strip, latest run and incidents', async () => {
    const page = await loadToolPage(source, kept);
    expect(page?.tool.optedOutAt).toEqual(expect.any(String));
    expect(page?.strip.length).toBeGreaterThan(0);
    expect(page?.latestRun).not.toBeNull();
  });

  it('a tool whose history is hidden shows none, even when the data layer below still has rows', async () => {
    const page = await loadToolPage(source, hidden);
    expect(page).not.toBeNull();
    expect(page?.tool).toMatchObject({ historyHidden: true });
    expect(page?.strip).toEqual([]);
    expect(page?.latestRun).toBeNull();
    expect(page?.openIncident).toBeNull();
    expect(page?.incidents).toEqual([]);
    expect(JSON.stringify(page)).not.toContain(HIDDEN_HISTORY_MARKER);
  });

  it('both pages exist (the slugs are known)', async () => {
    expect(await loadKnownSlugs(source)).toEqual(expect.arrayContaining([kept, hidden]));
  });
});

describe('loadRunPage', () => {
  it('a run of an opted-out tool is still a page', async () => {
    const id = (await source.listTools()).find((t) => t.slug === kept)?.last_run_id as string;
    expect((await loadRunPage(source, id))?.toolSlug).toBe(kept);
  });

  it('a run of a tool whose history is hidden is not found, though the data layer would return it', async () => {
    const [h] = await source.listToolHistory(hidden, 1);
    expect(h).toBeDefined();
    expect(await source.getRun((h as { run_id: string }).run_id)).not.toBeNull();
    expect(await loadRunPage(source, (h as { run_id: string }).run_id)).toBeNull();
  });
});

describe('loadIncidentsPage', () => {
  it('leaves out the incidents of a tool whose history is hidden', async () => {
    const views = await loadIncidentsPage(source);
    expect(JSON.stringify(views)).not.toContain(HIDDEN_HISTORY_MARKER);
    expect(views.some((v) => v.toolSlug === hidden)).toBe(false);
    expect(views.length).toBeGreaterThan(0);
  });
});

describe('the badge and the image', () => {
  it('the badge says no longer monitored, for both', async () => {
    expect(await loadBadgeStatus(source, kept)).toBe('opted_out');
    expect(await loadBadgeStatus(source, hidden)).toBe('opted_out');
    expect(badgeFor('opted_out')).toMatchObject({
      label: 'quickstart',
      value: OPT_OUT.badgeValue,
    });
  });

  it('the image card carries the label and no result', async () => {
    const data = await loadOgData(source, kept);
    expect(data?.optedOut).toBe(true);
    const card = ogCard(data as NonNullable<typeof data>);
    expect(card.statusLabel).toBe(OPT_OUT.pageLabel);
    expect(card.errorLine).toBeNull();
    expect(card.since).toBeNull();
  });
});

describe('a row from a database that has not applied the migration', () => {
  it('parses as a tool that did not opt out', () => {
    const row = PublicToolRow.parse({
      slug: 'old-node',
      name: 'Old',
      docs_url: 'https://old.dev',
      language: 'node',
      level: 2,
      status: 'HEALTHY',
      status_since: null,
      last_run_at: null,
      pass_rate_30d: null,
      current_streak: 0,
      streak_kind: 'pass',
      last_run_id: null,
      last_outcome: null,
      last_reached_level: null,
      last_skip_reason: null,
      decided_30d: 0,
    });
    expect(buildToolSummaries([row], [], [])[0]).toMatchObject({
      optedOutAt: null,
      historyHidden: false,
    });
  });
});

describe('what this check does not cover', () => {
  it('the view model carries the notes of the row, none by default', async () => {
    const tools = await source.listTools();
    const noted = tools.find((t) => t.coverage_notes.length > 0);
    expect(noted, 'a fixture tool has notes').toBeDefined();
    const [summary] = buildToolSummaries([noted as NonNullable<typeof noted>], [], []);
    expect(summary?.coverageNotes).toEqual(noted?.coverage_notes);
    const plain = tools.find((t) => t.coverage_notes.length === 0);
    expect(
      buildToolSummaries([plain as NonNullable<typeof plain>], [], [])[0]?.coverageNotes,
    ).toEqual([]);
  });
});
