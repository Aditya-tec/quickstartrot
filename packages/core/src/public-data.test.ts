import { describe, expect, it } from 'vitest';
import {
  PublicIncidentRow,
  PublicRunHistoryRow,
  PublicRunRow,
  PublicToolRow,
  computeHeadline,
  confirmedOnly,
  isTested,
  publicStatus,
  sanitizeRun,
  type PublicStatus,
} from './public-data.js';

// What the public website reads (spec section 13) and the rules that decide what it may show. These pure
// functions are the single source of truth for the status shown on a page, in the badge and in the OG image,
// and the last line of defence for the rule "an unreviewed failure shows `verifying` and no cause text".

const NOW = '2026-10-17T12:00:00+00:00';
const CAUSE = 'ZZCAUSE: acme.send is not a function';

const toolRow = (over: Record<string, unknown> = {}) => ({
  slug: 'acme-node',
  name: 'Acme',
  docs_url: 'https://docs.acme.dev/quickstart',
  language: 'node',
  level: 3,
  status: 'HEALTHY',
  status_since: NOW,
  last_run_at: NOW,
  pass_rate_30d: '0.9667',
  current_streak: 12,
  streak_kind: 'pass',
  last_run_id: '0f9d2c1e-1111-4111-8111-0123456789ab',
  last_outcome: 'PASS',
  last_reached_level: 3,
  last_skip_reason: null,
  decided_30d: 30,
  ...over,
});

const stepRow = (over: Record<string, unknown> = {}) => ({
  step_id: 's2',
  ordinal: 1,
  kind: 'run',
  outcome: 'FAIL',
  exit_code: 1,
  duration_ms: 120,
  stdout_tail: 'some output',
  stderr_tail: CAUSE,
  log_path: 'logs/c/acme-1-tok/01-s2.log.gz',
  ...over,
});

const runRow = (over: Record<string, unknown> = {}) => ({
  id: '0f9d2c1e-1111-4111-8111-0123456789ab',
  tool_slug: 'acme-node',
  cycle_id: '5d1b8c1e-2f4a-4b8e-9d3c-0123456789ab',
  attempt: 1,
  outcome: 'FAIL',
  failure_class: 'API_DRIFT',
  failure_signature: 'ZZSIG-1',
  failed_step_id: 's2',
  image_digest: 'sha256:abc',
  runner_env: { node: 'v22.1.0' },
  duration_ms: 4200,
  started_at: NOW,
  finished_at: NOW,
  snapshot_hash: 'h'.repeat(64),
  plan_ir: null,
  grounding_report: { ok: true, violations: [] },
  steps: [
    stepRow({
      step_id: 's1',
      ordinal: 0,
      outcome: 'PASS',
      stderr_tail: null,
      stdout_tail: null,
      log_path: null,
    }),
    stepRow(),
  ],
  details_published: true,
  reached_level: 2,
  skip_reason: null,
  plan_compiler_version: '2026-10-16.5',
  plan_truncation: null,
  plan_stale: false,
  snapshot_blocks: null,
  snapshot_title: null,
  snapshot_url: null,
  ...over,
});

const incidentRow = (over: Record<string, unknown> = {}) => ({
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  tool_slug: 'acme-node',
  tool_name: 'Acme',
  signature: 'conf-sig',
  failure_class: 'API_DRIFT',
  state: 'OPEN',
  review: 'CONFIRMED',
  first_failing_run_id: null,
  last_passing_run_id: null,
  docs_changed: true,
  docs_diff_path: 'diffs/acme.diff',
  summary: 'The send method was renamed.',
  suggested_fix: 'Use deliver().',
  opened_at: NOW,
  confirmed_at: NOW,
  resolved_at: null,
  events: [],
  version_diff: { changed: [{ name: 'acme', from: '3.4.1', to: '4.0.0' }], added: [], removed: [] },
  ...over,
});

describe('row schemas (the boundary with the database)', () => {
  it('parse a public_tools row, turning a numeric string into a number', () => {
    const t = PublicToolRow.parse(toolRow());
    expect(t.pass_rate_30d).toBeCloseTo(0.9667);
    expect(PublicToolRow.parse(toolRow({ pass_rate_30d: 0.5 })).pass_rate_30d).toBe(0.5);
    expect(PublicToolRow.parse(toolRow({ pass_rate_30d: null })).pass_rate_30d).toBeNull();
  });

  it('a tool that never ran has null latest-run fields', () => {
    const t = PublicToolRow.parse(
      toolRow({
        status: 'UNKNOWN',
        last_run_id: null,
        last_outcome: null,
        last_reached_level: null,
        status_since: null,
        last_run_at: null,
        pass_rate_30d: null,
        decided_30d: 0,
      }),
    );
    expect(t.last_outcome).toBeNull();
  });

  it('refuse a row that is not what the view promises', () => {
    expect(PublicToolRow.safeParse(toolRow({ status: 'FINE' })).success).toBe(false);
    expect(PublicToolRow.safeParse(toolRow({ slug: 42 })).success).toBe(false);
    expect(PublicToolRow.safeParse({ slug: 'x' }).success).toBe(false);
  });

  it('parse run history, run and incident rows', () => {
    expect(
      PublicRunHistoryRow.safeParse({
        run_id: '0f9d2c1e-1111-4111-8111-0123456789ab',
        tool_slug: 'acme-node',
        started_at: NOW,
        outcome: 'PASS',
        kind: 'pass',
        reached_level: 3,
        target_level: 3,
        stale: false,
        duration_ms: 4200,
        rn: 1,
      }).success,
    ).toBe(true);
    expect(PublicRunRow.safeParse(runRow()).success).toBe(true);
    expect(PublicIncidentRow.safeParse(incidentRow()).success).toBe(true);
    expect(PublicRunRow.safeParse(runRow({ steps: 'nope' })).success).toBe(false);
  });
});

describe('publicStatus: one function for the page, the badge and the OG image', () => {
  const s = (over: Partial<Parameters<typeof publicStatus>[0]>): PublicStatus =>
    publicStatus({
      status: 'HEALTHY',
      lastOutcome: 'PASS',
      hasConfirmedOpenIncident: false,
      ...over,
    });

  it.each([
    [{ status: 'HEALTHY' }, 'passing'],
    [{ status: 'UNKNOWN', lastOutcome: null }, 'unknown'],
    [{ status: 'DEGRADED', lastOutcome: 'FAIL' }, 'verifying'],
    [{ status: 'BROKEN', lastOutcome: 'FAIL', hasConfirmedOpenIncident: true }, 'failing'],
    [{ status: 'UNKNOWN', lastOutcome: 'SKIPPED' }, 'needs_person'],
  ] as const)('%j -> %s', (input, expected) => {
    expect(s(input as Partial<Parameters<typeof publicStatus>[0]>)).toBe(expected);
  });

  it('BROKEN without a confirmed open incident is "verifying", never "failing"', () => {
    expect(s({ status: 'BROKEN', hasConfirmedOpenIncident: false })).toBe('verifying');
  });

  it('"failing" needs the confirmed incident, whatever the status string says', () => {
    expect(s({ status: 'DEGRADED', hasConfirmedOpenIncident: true })).toBe('failing');
  });

  it('a tool whose latest run needs a person is "needs_person", unless a confirmed incident stands', () => {
    expect(s({ status: 'HEALTHY', lastOutcome: 'SKIPPED' })).toBe('needs_person');
    expect(s({ status: 'BROKEN', lastOutcome: 'SKIPPED', hasConfirmedOpenIncident: true })).toBe(
      'failing',
    );
  });
});

describe('isTested', () => {
  it('counts a tool that ran and has a verdict or a verdict being verified; not an unknown or a needs-a-person tool', () => {
    expect(isTested('passing')).toBe(true);
    expect(isTested('failing')).toBe(true);
    expect(isTested('verifying')).toBe(true);
    expect(isTested('unknown')).toBe(false);
    expect(isTested('needs_person')).toBe(false);
  });
});

describe('computeHeadline: level-aware and honest', () => {
  const t = (status: PublicStatus, level: number) => ({ status, level });

  it('X of Y: Y is the tools that were tested, SKIPPED and never-run tools are in neither', () => {
    const h = computeHeadline([
      t('passing', 3),
      t('passing', 3),
      t('passing', 2),
      t('failing', 3),
      t('verifying', 2),
      t('needs_person', 2),
      t('unknown', 3),
    ]);
    expect(h.passing).toBe(3);
    expect(h.tested).toBe(5);
    expect(h.failing).toBe(1);
    expect(h.verifying).toBe(1);
    expect(h.needsPerson).toBe(1);
    expect(h.notTested).toBe(1);
  });

  it('says how many tested tools reached the vendor (L3) and how many only built (L2) or only installed (L1)', () => {
    const h = computeHeadline([
      t('passing', 3),
      t('passing', 3),
      t('failing', 3),
      t('passing', 2),
      t('verifying', 2),
      t('passing', 1),
    ]);
    expect(h.testedAtL3).toBe(3);
    expect(h.testedAtL2).toBe(2);
    expect(h.testedAtL1).toBe(1);
    expect(h.passingAtL3).toBe(2);
    expect(h.passingAtL2).toBe(1);
    expect(h.passingAtL1).toBe(1);
    expect(h.testedAtL3 + h.testedAtL2 + h.testedAtL1).toBe(h.tested);
  });

  it('an L4 tool counts with L3 (it reaches the vendor too)', () => {
    const h = computeHeadline([t('passing', 4)]);
    expect(h.testedAtL3).toBe(1);
  });

  it('an empty list is all zeros', () => {
    expect(computeHeadline([])).toMatchObject({
      passing: 0,
      tested: 0,
      testedAtL3: 0,
      notTested: 0,
    });
  });
});

describe('confirmedOnly', () => {
  it('drops everything a person has not confirmed, whatever the database sent', () => {
    const rows = [
      PublicIncidentRow.parse(incidentRow()),
      PublicIncidentRow.parse(
        incidentRow({
          id: '11111111-1111-4111-8111-111111111111',
          review: 'PENDING_REVIEW',
          summary: CAUSE,
        }),
      ),
      PublicIncidentRow.parse(
        incidentRow({
          id: '22222222-2222-4222-8222-222222222222',
          review: 'FALSE_POSITIVE',
          summary: CAUSE,
        }),
      ),
    ];
    const kept = confirmedOnly(rows);
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept)).not.toContain('ZZ');
  });
});

describe('sanitizeRun: the last line of defence', () => {
  const confirmed = confirmedOnly([PublicIncidentRow.parse(incidentRow())]);

  it('a failing run with no confirmed incident shows no cause, even if the row claims its details are published', () => {
    const safe = sanitizeRun(PublicRunRow.parse(runRow({ details_published: true })), []);
    expect(safe.causeVisible).toBe(false);
    expect(safe.failure_class).toBeNull();
    expect(safe.failure_signature).toBeNull();
    expect(safe.failed_step_id).toBeNull();
    expect(
      safe.steps.every(
        (st) =>
          st.stderr_tail === null &&
          st.stdout_tail === null &&
          st.log_path === null &&
          st.exit_code === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('ZZ');
  });

  it('...and the same when only another tool has a confirmed incident', () => {
    const other = confirmedOnly([PublicIncidentRow.parse(incidentRow({ tool_slug: 'bolt-node' }))]);
    const safe = sanitizeRun(PublicRunRow.parse(runRow()), other);
    expect(safe.causeVisible).toBe(false);
    expect(JSON.stringify(safe)).not.toContain('ZZ');
  });

  it('a row the database already masked stays masked, with a confirmed incident or not', () => {
    const masked = PublicRunRow.parse(
      runRow({
        details_published: false,
        failure_class: null,
        failure_signature: null,
        failed_step_id: null,
        steps: [stepRow({ stderr_tail: null, stdout_tail: null, log_path: null, exit_code: null })],
      }),
    );
    expect(sanitizeRun(masked, confirmed).causeVisible).toBe(false);
  });

  it('a failing run inside a confirmed incident of the same tool keeps its cause', () => {
    const safe = sanitizeRun(PublicRunRow.parse(runRow()), confirmed);
    expect(safe.causeVisible).toBe(true);
    expect(safe.failure_class).toBe('API_DRIFT');
    expect(safe.steps[1]?.stderr_tail).toBe(CAUSE);
  });

  it('a passing run is untouched', () => {
    const pass = PublicRunRow.parse(
      runRow({
        outcome: 'PASS',
        failure_class: null,
        failure_signature: null,
        failed_step_id: null,
      }),
    );
    const safe = sanitizeRun(pass, []);
    expect(safe.causeVisible).toBe(true);
    expect(safe.steps[1]?.stderr_tail).toBe(CAUSE);
  });

  it('a run that never reached the executor keeps its class: it is about us, not the vendor', () => {
    const pre = PublicRunRow.parse(
      runRow({
        failure_class: 'CRAWL_ERROR',
        failure_signature: 'CRAWL_ERROR:no_code_blocks',
        steps: [],
      }),
    );
    const safe = sanitizeRun(pre, []);
    expect(safe.causeVisible).toBe(true);
    expect(safe.failure_class).toBe('CRAWL_ERROR');
  });
});
