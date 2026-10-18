import { describe, expect, it } from 'vitest';
import {
  PublicIncidentRow,
  PublicRunHistoryRow,
  type PublicRunRow,
  PublicToolRow,
} from '@qsr/core/public';
import {
  FIXTURE_NOW,
  FIXTURE_SLUGS,
  FixtureDataSource,
  UNREVIEWED_CAUSE,
  fixtureDiff,
  fixtureLog,
} from './fixtures.js';

// The seeded data behind QSR_DATA=fixtures: development, Playwright, screenshots and Lighthouse all use it. It must
// cover every state a page can be in, and it deliberately includes "poisoned" rows (an unreviewed incident with a
// distinctive cause, a failing run whose row claims its details are published) so the leak tests can prove the
// app keeps an unreviewed cause out even when the data layer below it lets one through.

const source = new FixtureDataSource();

describe('the fixture data', () => {
  it('has a fixed clock, so screenshots and relative times are reproducible', () => {
    expect(FIXTURE_NOW.toISOString()).toBe('2026-10-17T12:00:00.000Z');
  });

  it('every row parses with the same schemas the Supabase source uses', async () => {
    const tools = await source.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(10);
    for (const t of tools) expect(PublicToolRow.safeParse(t).success, t.slug).toBe(true);
    for (const h of await source.listHistory(60))
      expect(PublicRunHistoryRow.safeParse(h).success).toBe(true);
    for (const i of await source.listIncidents())
      expect(PublicIncidentRow.safeParse(i).success).toBe(true);
  });

  it('covers every state: passing, verifying, failing, unknown, needs a person, stale plan, long name, 0 and 100 runs', async () => {
    const tools = await source.listTools();
    const by = (slug: string) => tools.find((t) => t.slug === slug);
    expect(by(FIXTURE_SLUGS.healthy)?.status).toBe('HEALTHY');
    expect(by(FIXTURE_SLUGS.verifying)?.status).toBe('DEGRADED');
    expect(by(FIXTURE_SLUGS.failing)?.status).toBe('BROKEN');
    expect(by(FIXTURE_SLUGS.unknown)?.status).toBe('UNKNOWN');
    expect(by(FIXTURE_SLUGS.unknown)?.last_run_id).toBeNull();
    expect(by(FIXTURE_SLUGS.needsPerson)?.last_outcome).toBe('SKIPPED');
    expect(by(FIXTURE_SLUGS.longName)?.name.length).toBeGreaterThan(50);
    expect(by(FIXTURE_SLUGS.manyRuns)?.decided_30d).toBe(100);
    expect(tools.some((t) => t.level === 2)).toBe(true);
    expect(tools.some((t) => t.level === 3)).toBe(true);
    expect(tools.some((t) => t.language === 'python')).toBe(true);
  });

  it('a tool with zero runs has no history; one with 100 has the newest 60, ranked 1..60', async () => {
    const history = await source.listHistory(60);
    expect(history.filter((h) => h.tool_slug === FIXTURE_SLUGS.unknown)).toEqual([]);
    const many = history.filter((h) => h.tool_slug === FIXTURE_SLUGS.manyRuns);
    expect(many).toHaveLength(60);
    expect(many.map((h) => h.rn).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
  });

  it('listHistory(limit) keeps the newest `limit` per tool', async () => {
    const h = await source.listHistory(28);
    expect(h.filter((x) => x.tool_slug === FIXTURE_SLUGS.manyRuns)).toHaveLength(28);
    expect(Math.max(...h.map((x) => x.rn))).toBe(28);
    expect(await source.listToolHistory(FIXTURE_SLUGS.manyRuns, 5)).toHaveLength(5);
  });

  it('has a stale-plan run, with a truncated plan on one tool', async () => {
    const history = await source.listHistory(60);
    expect(history.some((h) => h.stale)).toBe(true);
    const staleRun = history.find((h) => h.stale) as PublicRunHistoryRow;
    const run = (await source.getRun(staleRun.run_id)) as PublicRunRow;
    expect(run.plan_stale).toBe(true);
  });

  it('has runs of both harness versions: the stale-plan run is an older v1 run, the rest are v2', async () => {
    const history = await source.listHistory(60);
    const staleRun = history.find((h) => h.stale) as PublicRunHistoryRow;
    expect(((await source.getRun(staleRun.run_id)) as PublicRunRow).harness_version).toBe(1);
    const fresh = history.find((h) => !h.stale) as PublicRunHistoryRow;
    expect(((await source.getRun(fresh.run_id)) as PublicRunRow).harness_version).toBe(2);
  });

  it('has a CONFIRMED incident with a summary, a suggested fix, a docs diff and a version diff', async () => {
    const incidents = await source.listIncidents();
    const confirmed = incidents.find(
      (i) => i.tool_slug === FIXTURE_SLUGS.failing && i.review === 'CONFIRMED',
    );
    expect(confirmed).toBeDefined();
    expect(confirmed?.summary).toBeTruthy();
    expect(confirmed?.suggested_fix).toBeTruthy();
    expect(confirmed?.docs_changed).toBe(true);
    expect(confirmed?.docs_diff_path).toBeTruthy();
    expect(confirmed?.version_diff?.changed.length).toBeGreaterThan(0);
  });

  it('POISON: also serves a PENDING_REVIEW incident carrying a distinctive cause, as if the view had leaked it', async () => {
    expect(UNREVIEWED_CAUSE).toMatch(/^ZZ/);
    const incidents = await source.listIncidents();
    const pending = incidents.find((i) => i.review === 'PENDING_REVIEW');
    expect(pending?.tool_slug).toBe(FIXTURE_SLUGS.verifying);
    expect(JSON.stringify(pending)).toContain(UNREVIEWED_CAUSE);
  });

  it('POISON: the unreviewed tool failing run claims published details with the cause in its steps and class', async () => {
    const history = await source.listToolHistory(FIXTURE_SLUGS.verifying, 60);
    const failing = history.find((h) => h.kind === 'fail') as PublicRunHistoryRow;
    const run = (await source.getRun(failing.run_id)) as PublicRunRow;
    expect(run.details_published).toBe(true);
    expect(run.failure_class).toBe('API_DRIFT');
    expect(JSON.stringify(run)).toContain(UNREVIEWED_CAUSE);
  });

  it('every history row has a run to open', async () => {
    for (const h of (await source.listHistory(60)).slice(0, 80))
      expect(await source.getRun(h.run_id), h.run_id).not.toBeNull();
    expect(await source.getRun('00000000-0000-4000-8000-ffffffffffff')).toBeNull();
  });

  it('the latest run of every tool that has run is openable', async () => {
    for (const t of await source.listTools())
      if (t.last_run_id) expect(await source.getRun(t.last_run_id), t.slug).not.toBeNull();
  });

  it('serves a gzipped log and a docs diff for the paths the confirmed incident and its runs point at', async () => {
    const incidents = await source.listIncidents();
    const diffPath = incidents.find((i) => i.review === 'CONFIRMED')?.docs_diff_path as string;
    expect(fixtureDiff(diffPath)).toMatch(/^[-+@ ]/m);
    const history = await source.listToolHistory(FIXTURE_SLUGS.failing, 5);
    const failed = history.find((h) => h.kind === 'fail') as PublicRunHistoryRow;
    const run = (await source.getRun(failed.run_id)) as PublicRunRow;
    const logPath = run.steps.find((s) => s.log_path)?.log_path as string;
    const gz = fixtureLog(logPath) as Buffer;
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(fixtureLog('logs/not/a/real/path.log.gz')).toBeNull();
  });

  it('the log and the diff of the UNREVIEWED tool exist too (so a test can prove the page never links them)', async () => {
    const history = await source.listToolHistory(FIXTURE_SLUGS.verifying, 60);
    const run = (await source.getRun(
      (history.find((h) => h.kind === 'fail') as PublicRunHistoryRow).run_id,
    )) as PublicRunRow;
    const logPath = run.steps.find((s) => s.log_path)?.log_path as string;
    expect(fixtureLog(logPath)).not.toBeNull();
    const pending = (await source.listIncidents()).find(
      (i) => i.review === 'PENDING_REVIEW',
    ) as PublicIncidentRow;
    expect(fixtureDiff(pending.docs_diff_path as string)).toContain(UNREVIEWED_CAUSE);
  });
});
