import { describe, expect, it } from 'vitest';
import { PublicIncidentRow, PublicRunHistoryRow, PublicToolRow } from '@qsr/core/public';
import { buildHomeModel, buildIncidentViews, buildToolSummaries } from './model.js';

// The view model is what pages render. It is built from view rows, and it is where "verifying" is decided and
// where nothing that could be a cause is allowed to pass.

const CAUSE = 'ZZCAUSE: acme.send is not a function';
const T = '2026-10-17T12:00:00Z';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const tool = (slug: string, over: Record<string, unknown> = {}) =>
  PublicToolRow.parse({
    slug,
    name: `Tool ${slug}`,
    docs_url: `https://docs.${slug}.dev`,
    language: 'node',
    level: 3,
    status: 'HEALTHY',
    status_since: '2026-10-01T00:00:00Z',
    last_run_at: T,
    pass_rate_30d: 1,
    current_streak: 5,
    streak_kind: 'pass',
    last_run_id: id(1),
    last_outcome: 'PASS',
    last_reached_level: 3,
    last_skip_reason: null,
    decided_30d: 10,
    ...over,
  });

const hist = (slug: string, rn: number, kind = 'pass', over: Record<string, unknown> = {}) =>
  PublicRunHistoryRow.parse({
    run_id: id(1000 + rn),
    tool_slug: slug,
    started_at: new Date(Date.parse(T) - rn * 3600_000).toISOString(),
    outcome: kind === 'pass' ? 'PASS' : kind === 'skipped' ? 'SKIPPED' : 'FAIL',
    kind,
    reached_level: 3,
    target_level: 3,
    stale: false,
    duration_ms: 4000,
    rn,
    ...over,
  });

const incident = (slug: string, over: Record<string, unknown> = {}) =>
  PublicIncidentRow.parse({
    id: id(7),
    tool_slug: slug,
    tool_name: `Tool ${slug}`,
    signature: 'sig',
    failure_class: 'API_DRIFT',
    state: 'OPEN',
    review: 'CONFIRMED',
    first_failing_run_id: null,
    last_passing_run_id: null,
    docs_changed: true,
    docs_diff_path: 'diffs/x.diff',
    summary: 'The send method was renamed. Update your imports.',
    suggested_fix: 'Use deliver().',
    opened_at: '2026-10-12T08:00:00Z',
    confirmed_at: '2026-10-12T10:00:00Z',
    resolved_at: null,
    events: [],
    version_diff: null,
    ...over,
  });

describe('buildToolSummaries', () => {
  it('gives each tool its own strip, oldest to newest, at most 28 long', () => {
    const history = [
      ...Array.from({ length: 40 }, (_, i) => hist('a-node', i + 1)),
      hist('b-node', 1, 'fail'),
    ];
    const [a, b] = buildToolSummaries([tool('a-node'), tool('b-node')], history, []);
    expect(a?.strip).toHaveLength(28);
    expect((a?.strip[0]?.at ?? '') < (a?.strip[27]?.at ?? '')).toBe(true); // oldest first
    expect(b?.strip).toHaveLength(1);
    expect(b?.strip[0]?.kind).toBe('fail');
  });

  it.each([
    [{ status: 'HEALTHY' }, [], 'passing'],
    [{ status: 'UNKNOWN', last_outcome: null, last_run_id: null }, [], 'unknown'],
    [{ status: 'DEGRADED', last_outcome: 'FAIL' }, [], 'verifying'],
    [{ status: 'BROKEN', last_outcome: 'FAIL' }, [], 'verifying'],
    [{ status: 'BROKEN', last_outcome: 'FAIL' }, ['confirmed'], 'failing'],
    [{ status: 'UNKNOWN', last_outcome: 'SKIPPED' }, [], 'needs_person'],
  ] as const)('%j with incidents %j is %s', (over, incidents, expected) => {
    const rows = incidents.length ? [incident('a-node')] : [];
    const [a] = buildToolSummaries([tool('a-node', over as Record<string, unknown>)], [], rows);
    expect(a?.status).toBe(expected);
  });

  it('a failing tool says since when: the status date, else the incident', () => {
    const [a] = buildToolSummaries(
      [
        tool('a-node', {
          status: 'BROKEN',
          status_since: '2026-10-12T07:00:00Z',
          last_outcome: 'FAIL',
        }),
      ],
      [],
      [incident('a-node')],
    );
    expect(a?.failingSince).toBe('2026-10-12T07:00:00Z');
    const [b] = buildToolSummaries(
      [tool('b-node', { status: 'BROKEN', status_since: null, last_outcome: 'FAIL' })],
      [],
      [incident('b-node')],
    );
    expect(b?.failingSince).toBe('2026-10-12T08:00:00Z');
  });

  it('a RESOLVED confirmed incident does not make a tool failing', () => {
    const [a] = buildToolSummaries(
      [tool('a-node')],
      [],
      [incident('a-node', { state: 'RESOLVED', resolved_at: T })],
    );
    expect(a?.status).toBe('passing');
  });

  it('SAFETY: a pending or false-positive incident the database should not have sent changes nothing and leaks nothing', () => {
    const poisoned = [
      incident('a-node', {
        review: 'PENDING_REVIEW',
        summary: CAUSE,
        suggested_fix: CAUSE,
        signature: CAUSE,
      }),
      incident('a-node', { id: id(8), review: 'FALSE_POSITIVE', summary: CAUSE }),
    ];
    const summaries = buildToolSummaries(
      [tool('a-node', { status: 'BROKEN', last_outcome: 'FAIL' })],
      [hist('a-node', 1, 'fail')],
      poisoned,
    );
    expect(summaries[0]?.status).toBe('verifying');
    expect(JSON.stringify(summaries)).not.toContain('ZZ');
  });

  it('passes the numbers a table needs', () => {
    const [a] = buildToolSummaries(
      [tool('a-node', { pass_rate_30d: '0.9667', decided_30d: 30, current_streak: 12 })],
      [],
      [],
    );
    expect(a).toMatchObject({
      passRate: 0.9667,
      decided30d: 30,
      streak: { kind: 'pass', count: 12 },
      lastRunId: id(1),
      level: 3,
    });
  });
});

describe('buildHomeModel', () => {
  const summaries = () =>
    buildToolSummaries(
      [
        tool('a-node'),
        tool('b-node', { level: 2 }),
        tool('c-node', { status: 'DEGRADED', last_outcome: 'FAIL' }),
        tool('d-node', { status: 'BROKEN', last_outcome: 'FAIL' }),
        tool('hono-node', {
          status: 'UNKNOWN',
          last_outcome: 'SKIPPED',
          level: 2,
          last_skip_reason: 'manual_step',
        }),
        tool('new-node', {
          status: 'UNKNOWN',
          last_outcome: null,
          last_run_id: null,
          last_run_at: null,
        }),
      ],
      [],
      [incident('d-node')],
    );

  it('puts SKIPPED tools in their own group and out of both X and Y', () => {
    const m = buildHomeModel(summaries());
    expect(m.needsPerson.map((t) => t.slug)).toEqual(['hono-node']);
    expect(m.notTested.map((t) => t.slug)).toEqual(['new-node']);
    expect(m.tested.map((t) => t.slug).sort()).toEqual(['a-node', 'b-node', 'c-node', 'd-node']);
    expect(m.headline).toMatchObject({
      passing: 2,
      tested: 4,
      failing: 1,
      verifying: 1,
      needsPerson: 1,
      notTested: 1,
    });
  });

  it('is level-aware: how many tested tools reached the vendor (L3) and how many only built (L2)', () => {
    const m = buildHomeModel(summaries());
    expect(m.headline).toMatchObject({
      testedAtL3: 3,
      testedAtL2: 1,
      passingAtL3: 1,
      passingAtL2: 1,
    });
  });

  it('says when the data is from: the newest last_run_at', () => {
    expect(buildHomeModel(summaries()).asOf).toBe(T);
    expect(buildHomeModel([]).asOf).toBeNull();
  });
});

describe('buildIncidentViews', () => {
  it('lists confirmed incidents only, newest first, with a one-line cause and the time to resolve', () => {
    const views = buildIncidentViews([
      incident('a-node', {
        id: id(1),
        opened_at: '2026-10-10T08:00:00Z',
        state: 'RESOLVED',
        resolved_at: '2026-10-10T20:00:00Z',
        summary: 'First sentence here. Second sentence.',
      }),
      incident('b-node', { id: id(2), opened_at: '2026-10-12T08:00:00Z' }),
      incident('c-node', { id: id(3), review: 'PENDING_REVIEW', summary: CAUSE }),
    ]);
    expect(views.map((v) => v.id)).toEqual([id(2), id(1)]);
    expect(views[1]).toMatchObject({
      oneLine: 'First sentence here.',
      resolvedAfterMs: 12 * 3600_000,
    });
    expect(views[0]?.resolvedAfterMs).toBeNull();
    expect(JSON.stringify(views)).not.toContain('ZZ');
  });

  it('shortens a long unbroken summary to one line', () => {
    const [v] = buildIncidentViews([incident('a-node', { summary: 'x'.repeat(500) })]);
    expect((v?.oneLine ?? '').length).toBeLessThanOrEqual(160);
  });

  it('has a placeholder when a confirmed incident has no summary yet', () => {
    const [v] = buildIncidentViews([incident('a-node', { summary: null })]);
    expect(v?.oneLine).toBe('Cause being documented.');
  });
});
