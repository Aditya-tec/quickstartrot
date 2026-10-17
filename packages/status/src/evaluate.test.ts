import { describe, expect, it } from 'vitest';
import {
  FAILURES_TO_OPEN_INCIDENT,
  FAILURE_CLASSES,
  INITIAL_TOOL_STATE,
  StatusEvent,
  ToolState,
  TOOL_STATUSES,
  TRANSIENT_FAILURE_CLASSES,
  VENDOR_FAILURE_CLASSES,
  type FailureClass,
  type OpenIncident,
  type ResolvedIncident,
  type StatusContext,
  type StatusRun,
} from '@qsr/core';
import { evaluate } from './evaluate.js';

// Spec section 10, status engine. The describe blocks below are named after the spec's transition-table
// rows (in the spec's order), then the clarifications the owner gave, then the properties that must
// hold for EVERY input: total, idempotent, never mutating.

const T = '2026-10-16T12:00:00.000Z';
const day = 24 * 60 * 60 * 1000;
const ago = (ms: number): string => new Date(Date.parse(T) - ms).toISOString();

const state = (over: Partial<ToolState> = {}): ToolState => ({ ...INITIAL_TOOL_STATE, ...over });
const SIG_A = 'a'.repeat(64);
const SIG_B = 'b'.repeat(64);
const SIG_C = 'c'.repeat(64);

const pass = (over: Partial<StatusRun> = {}): StatusRun => ({
  outcome: 'PASS',
  failureClass: null,
  failureSignature: null,
  reachedLevel: 3,
  skipReason: null,
  finishedAt: T,
  ...over,
});
const fail = (
  failureClass: FailureClass | null,
  sig: string | null = SIG_A,
  over: Partial<StatusRun> = {},
): StatusRun => ({
  outcome: 'FAIL',
  failureClass,
  failureSignature: sig,
  reachedLevel: 1,
  skipReason: null,
  finishedAt: T,
  ...over,
});
const openIncident = (over: Partial<OpenIncident> = {}): OpenIncident => ({
  id: 'inc-open',
  signature: SIG_A,
  failureClass: 'API_DRIFT',
  ...over,
});
const resolved = (over: Partial<ResolvedIncident> = {}): ResolvedIncident => ({
  id: 'inc-old',
  signature: SIG_A,
  resolvedAt: ago(2 * day),
  ...over,
});
const ctx = (over: Partial<StatusContext> = {}): StatusContext => ({
  cycleValid: true,
  openIncident: null,
  recentlyResolvedIncidents: [],
  previousReachedLevel: null,
  ...over,
});
const types = (events: StatusEvent[]): string[] => events.map((e) => e.type);

const VENDOR = VENDOR_FAILURE_CLASSES;
const TRANSIENT = TRANSIENT_FAILURE_CLASSES;
const ADMIN = [
  'CRAWL_ERROR',
  'COMPILER_ERROR',
  'HARNESS_ERROR',
  'NEEDS_CREDENTIALS',
  'UNKNOWN',
] as const;

// ---------------------------------------------------------------------------------------------
describe('row 1: any / PASS -> HEALTHY once consecutive_passes reaches 2 (immediately from UNKNOWN); resolve the open incident if any', () => {
  it('UNKNOWN + PASS -> HEALTHY immediately', () => {
    const { next, events } = evaluate(state(), pass(), ctx());
    expect(next).toMatchObject({ status: 'HEALTHY', statusSince: T, consecutivePasses: 1 });
    expect(events).toEqual([]);
  });

  it('DEGRADED + PASS -> HEALTHY immediately (no incident exists yet), failure memory cleared', () => {
    const s = state({
      status: 'DEGRADED',
      statusSince: ago(day),
      consecutiveFailures: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const { next, events } = evaluate(s, pass(), ctx());
    expect(next).toEqual({
      ...INITIAL_TOOL_STATE,
      status: 'HEALTHY',
      statusSince: T,
      consecutivePasses: 1,
    });
    expect(events).toEqual([]);
  });

  it('HEALTHY + PASS stays HEALTHY: the pass is counted and status_since does not move', () => {
    const s = state({ status: 'HEALTHY', statusSince: ago(3 * day), consecutivePasses: 5 });
    const { next, events } = evaluate(s, pass(), ctx());
    expect(next).toEqual({ ...s, consecutivePasses: 6 });
    expect(events).toEqual([]);
  });

  it('BROKEN + PASS: the first pass does NOT change the status', () => {
    const s = state({
      status: 'BROKEN',
      statusSince: ago(day),
      consecutiveFailures: 3,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const { next, events } = evaluate(s, pass(), ctx({ openIncident: openIncident() }));
    expect(next).toMatchObject({
      status: 'BROKEN',
      statusSince: ago(day),
      consecutivePasses: 1,
      consecutiveFailures: 0,
      lastFailureSignature: SIG_A,
    });
    expect(events).toEqual([]);
  });

  it('BROKEN + PASS: the second consecutive pass -> HEALTHY and resolves the open incident', () => {
    const s = state({
      status: 'BROKEN',
      statusSince: ago(day),
      consecutivePasses: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const { next, events } = evaluate(
      s,
      pass(),
      ctx({ openIncident: openIncident({ id: 'inc-9' }) }),
    );
    expect(next).toEqual({
      ...INITIAL_TOOL_STATE,
      status: 'HEALTHY',
      statusSince: T,
      consecutivePasses: 2,
    });
    expect(events).toEqual([{ type: 'incident_resolved', incidentId: 'inc-9' }]);
  });

  it('BROKEN + second PASS with no open incident -> HEALTHY and nothing to resolve', () => {
    const s = state({ status: 'BROKEN', consecutivePasses: 1 });
    const { next, events } = evaluate(s, pass(), ctx());
    expect(next.status).toBe('HEALTHY');
    expect(events).toEqual([]);
  });

  it('a failure between two passes starts the pass count again', () => {
    const s = state({
      status: 'BROKEN',
      consecutivePasses: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const afterFail = evaluate(
      s,
      fail('API_DRIFT', SIG_A),
      ctx({ openIncident: openIncident() }),
    ).next;
    expect(afterFail.consecutivePasses).toBe(0);
    expect(evaluate(afterFail, pass(), ctx({ openIncident: openIncident() })).next.status).toBe(
      'BROKEN',
    );
  });

  it('a PASS clears the failure and transient streaks', () => {
    const s = state({
      status: 'HEALTHY',
      consecutiveFailures: 2,
      transientStreak: 3,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'TIMEOUT',
    });
    expect(evaluate(s, pass(), ctx()).next).toMatchObject({
      consecutiveFailures: 0,
      transientStreak: 0,
      lastFailureSignature: null,
      lastFailureClass: null,
    });
  });

  it('DEGRADED + PASS with a stale open incident (an inconsistency) still resolves it', () => {
    const { events } = evaluate(
      state({ status: 'DEGRADED' }),
      pass(),
      ctx({ openIncident: openIncident() }),
    );
    expect(events).toEqual([{ type: 'incident_resolved', incidentId: 'inc-open' }]);
  });
});

describe('row 2: HEALTHY / UNKNOWN + FAIL (vendor class), first failure -> DEGRADED, no event', () => {
  it.each(VENDOR.flatMap((c) => (['HEALTHY', 'UNKNOWN'] as const).map((s) => [c, s] as const)))(
    '%s from %s',
    (cls, from) => {
      const s = state({ status: from, statusSince: ago(day), consecutivePasses: 4 });
      const { next, events } = evaluate(s, fail(cls, SIG_A), ctx());
      expect(next).toEqual({
        status: 'DEGRADED',
        statusSince: T,
        consecutiveFailures: 1,
        consecutivePasses: 0,
        transientStreak: 0,
        lastFailureSignature: SIG_A,
        lastFailureClass: cls,
      });
      expect(events).toEqual([]);
    },
  );
});

describe('row 3: DEGRADED + FAIL (vendor class), same signature as the previous failure -> BROKEN (internal), open incident PENDING_REVIEW', () => {
  it.each(VENDOR)('%s', (cls) => {
    const s = state({
      status: 'DEGRADED',
      statusSince: ago(day),
      consecutiveFailures: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: cls,
    });
    const { next, events } = evaluate(s, fail(cls, SIG_A), ctx());
    expect(next).toMatchObject({
      status: 'BROKEN',
      statusSince: T,
      consecutiveFailures: 2,
      consecutivePasses: 0,
      lastFailureSignature: SIG_A,
      lastFailureClass: cls,
    });
    expect(events).toEqual([
      { type: 'incident_opened', failureClass: cls, signature: SIG_A, trigger: 'repeat_failure' },
    ]);
  });

  it('lands on exactly FAILURES_TO_OPEN_INCIDENT failures in a row (the constant the methodology quotes)', () => {
    const s = state({
      status: 'DEGRADED',
      consecutiveFailures: FAILURES_TO_OPEN_INCIDENT - 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    expect(evaluate(s, fail('API_DRIFT', SIG_A), ctx()).next.consecutiveFailures).toBe(
      FAILURES_TO_OPEN_INCIDENT,
    );
  });

  it('does not open a second incident when one is already open (a race)', () => {
    const s = state({
      status: 'DEGRADED',
      consecutiveFailures: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const { next, events } = evaluate(
      s,
      fail('API_DRIFT', SIG_A),
      ctx({ openIncident: openIncident() }),
    );
    expect(next.status).toBe('BROKEN');
    expect(events).toEqual([]);
  });
});

describe('row 4: DEGRADED + FAIL (vendor class), different signature -> DEGRADED, reset the failure streak to 1', () => {
  it('keeps DEGRADED, restarts the streak and remembers the new signature', () => {
    const s = state({
      status: 'DEGRADED',
      statusSince: ago(day),
      consecutiveFailures: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const { next, events } = evaluate(s, fail('DEPENDENCY_RESOLUTION', SIG_B), ctx());
    expect(next).toMatchObject({
      status: 'DEGRADED',
      statusSince: ago(day),
      consecutiveFailures: 1,
      lastFailureSignature: SIG_B,
      lastFailureClass: 'DEPENDENCY_RESOLUTION',
    });
    expect(events).toEqual([]);
  });

  it('DEGRADED by a transient failure has no failure signature to match, so a vendor failure is a first failure', () => {
    const s = state({ status: 'DEGRADED', transientStreak: 1 });
    const { next, events } = evaluate(s, fail('API_DRIFT', SIG_A), ctx());
    expect(next).toMatchObject({
      status: 'DEGRADED',
      consecutiveFailures: 1,
      transientStreak: 0,
      lastFailureSignature: SIG_A,
    });
    expect(events).toEqual([]);
  });
});

describe('row 5: any + FAIL (NETWORK_TRANSIENT / TIMEOUT), under 4 in a row -> unchanged, or DEGRADED from HEALTHY; no event', () => {
  it.each(TRANSIENT)('%s: HEALTHY -> DEGRADED on the first one', (cls) => {
    const s = state({ status: 'HEALTHY', statusSince: ago(day), consecutivePasses: 7 });
    const { next, events } = evaluate(s, fail(cls, SIG_C), ctx());
    expect(next).toMatchObject({
      status: 'DEGRADED',
      statusSince: T,
      transientStreak: 1,
      consecutivePasses: 0,
    });
    expect(events).toEqual([]);
  });

  it.each(['UNKNOWN', 'DEGRADED', 'BROKEN'] as const)(
    '%s is unchanged (status and status_since), the streak counts',
    (from) => {
      const s = state({
        status: from,
        statusSince: ago(day),
        consecutiveFailures: 2,
        lastFailureSignature: SIG_A,
        lastFailureClass: 'API_DRIFT',
      });
      const { next, events } = evaluate(
        s,
        fail('NETWORK_TRANSIENT', SIG_C),
        ctx({ openIncident: from === 'BROKEN' ? openIncident() : null }),
      );
      expect(next).toMatchObject({
        status: from,
        statusSince: ago(day),
        transientStreak: 1,
        consecutiveFailures: 2,
        lastFailureSignature: SIG_A,
      });
      expect(events).toEqual([]);
    },
  );

  it('a transient failure does not touch the vendor failure memory, so it cannot turn into a vendor streak', () => {
    const s = state({
      status: 'DEGRADED',
      consecutiveFailures: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const a = evaluate(s, fail('TIMEOUT', SIG_C), ctx()).next;
    expect(a).toMatchObject({ consecutiveFailures: 1, lastFailureSignature: SIG_A });
    expect(evaluate(a, fail('API_DRIFT', SIG_A), ctx()).next.status).toBe('BROKEN');
  });

  it('counts 1, 2, 3 across cycles without an incident', () => {
    let s = state({ status: 'HEALTHY' });
    for (const expected of [1, 2, 3]) {
      const r = evaluate(s, fail('NETWORK_TRANSIENT', SIG_C), ctx());
      expect(r.next.transientStreak).toBe(expected);
      expect(r.next.status).toBe('DEGRADED');
      expect(r.events).toEqual([]);
      s = r.next;
    }
  });
});

describe('row 6: any + FAIL (NETWORK_TRANSIENT / TIMEOUT), 4 in a row -> BROKEN (internal), open incident (likely registry or vendor outage)', () => {
  it.each(
    TRANSIENT.flatMap((c) =>
      (['UNKNOWN', 'HEALTHY', 'DEGRADED'] as const).map((s) => [c, s] as const),
    ),
  )('%s from %s on the 4th in a row', (cls, from) => {
    const s = state({ status: from, statusSince: ago(day), transientStreak: 3 });
    const { next, events } = evaluate(s, fail(cls, SIG_C), ctx());
    expect(next).toMatchObject({
      status: 'BROKEN',
      statusSince: T,
      transientStreak: 4,
      lastFailureSignature: SIG_C,
      lastFailureClass: cls,
    });
    expect(events).toEqual([
      { type: 'incident_opened', failureClass: cls, signature: SIG_C, trigger: 'transient_streak' },
    ]);
  });

  it('NETWORK_TRANSIENT and TIMEOUT count together', () => {
    let s = state({ status: 'HEALTHY' });
    const classes: FailureClass[] = [
      'NETWORK_TRANSIENT',
      'TIMEOUT',
      'NETWORK_TRANSIENT',
      'TIMEOUT',
    ];
    const all = classes.map((c) => {
      const r = evaluate(s, fail(c, SIG_C), ctx());
      s = r.next;
      return r;
    });
    expect(all.map((r) => r.next.status)).toEqual(['DEGRADED', 'DEGRADED', 'DEGRADED', 'BROKEN']);
    expect(types(all[3]?.events ?? [])).toEqual(['incident_opened']);
  });

  it('a vendor failure or a pass in between breaks the "in a row"', () => {
    const s = state({ status: 'DEGRADED', transientStreak: 3 });
    expect(evaluate(s, fail('API_DRIFT', SIG_A), ctx()).next.transientStreak).toBe(0);
    expect(evaluate(s, pass(), ctx()).next.transientStreak).toBe(0);
  });

  it('an already BROKEN tool with an open incident opens no second one', () => {
    const s = state({
      status: 'BROKEN',
      transientStreak: 5,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const { next, events } = evaluate(
      s,
      fail('NETWORK_TRANSIENT', SIG_C),
      ctx({ openIncident: openIncident() }),
    );
    expect(next).toMatchObject({
      status: 'BROKEN',
      transientStreak: 6,
      lastFailureSignature: SIG_A,
    });
    expect(events).toEqual([]);
  });
});

describe('row 7: any + CRAWL_ERROR / COMPILER_ERROR / HARNESS_ERROR / NEEDS_CREDENTIALS / UNKNOWN -> unchanged; admin queue item, never an incident', () => {
  const REASON: Record<(typeof ADMIN)[number], string> = {
    CRAWL_ERROR: 'crawl_error',
    COMPILER_ERROR: 'compiler_error',
    HARNESS_ERROR: 'harness_error',
    NEEDS_CREDENTIALS: 'needs_credentials',
    UNKNOWN: 'unknown_failure',
  };
  const populated = (status: ToolState['status']): ToolState =>
    state({
      status,
      statusSince: ago(day),
      consecutiveFailures: 2,
      consecutivePasses: 1,
      transientStreak: 2,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });

  it.each(ADMIN.flatMap((c) => TOOL_STATUSES.map((s) => [c, s] as const)))(
    '%s on a %s tool changes nothing but queues an item',
    (cls, from) => {
      const s = populated(from);
      const { next, events } = evaluate(
        s,
        fail(cls, SIG_C),
        ctx({ openIncident: from === 'BROKEN' ? openIncident() : null }),
      );
      expect(next).toEqual(s);
      expect(events).toEqual([
        {
          type: 'admin_queue',
          reason: REASON[cls],
          failureClass: cls,
          signature: SIG_C,
          detail: expect.any(String),
        },
      ]);
    },
  );

  it('a harness-error OUTCOME is queued the same way, whatever class came with it', () => {
    const run = fail('HARNESS_ERROR', null, { outcome: 'HARNESS_ERROR' });
    const { next, events } = evaluate(populated('HEALTHY'), run, ctx());
    expect(next).toEqual(populated('HEALTHY'));
    expect(events).toMatchObject([{ type: 'admin_queue', reason: 'harness_error' }]);
    expect(
      evaluate(populated('HEALTHY'), { ...run, failureClass: null }, ctx()).events,
    ).toMatchObject([{ reason: 'harness_error' }]);
  });

  it('a SKIPPED run (a manual step before the target level) changes nothing: admin queue, never an incident', () => {
    const run = fail('NEEDS_CREDENTIALS', SIG_C, {
      outcome: 'SKIPPED',
      skipReason: 'manual_step',
      reachedLevel: 1,
    });
    const s = populated('DEGRADED');
    const { next, events } = evaluate(s, run, ctx());
    expect(next).toEqual(s);
    expect(events).toMatchObject([
      { type: 'admin_queue', reason: 'skipped', failureClass: 'NEEDS_CREDENTIALS' },
    ]);
  });

  it('a tool that used to reach a higher level and now stops earlier at a manual step: plan_regressed', () => {
    const run = fail('NEEDS_CREDENTIALS', SIG_C, {
      outcome: 'SKIPPED',
      skipReason: 'manual_step',
      reachedLevel: 1,
    });
    const { next, events } = evaluate(populated('HEALTHY'), run, ctx({ previousReachedLevel: 3 }));
    expect(next).toEqual(populated('HEALTHY'));
    expect(events).toMatchObject([
      { type: 'admin_queue', reason: 'plan_regressed', detail: expect.stringContaining('L3') },
    ]);
    expect(events).toHaveLength(1);
  });

  it.each([
    ['the same level', 1],
    ['a lower level', 0],
    ['an unknown previous level', null],
  ])('not plan_regressed when the previous run reached %s', (_name, previous) => {
    const run = fail('NEEDS_CREDENTIALS', SIG_C, {
      outcome: 'SKIPPED',
      skipReason: 'manual_step',
      reachedLevel: 1,
    });
    expect(
      evaluate(populated('HEALTHY'), run, ctx({ previousReachedLevel: previous })).events,
    ).toMatchObject([{ reason: 'skipped' }]);
  });

  it('a FAIL with no class, or a vendor/transient class with no signature, cannot be judged: queued as unclassified', () => {
    for (const run of [fail(null, SIG_A), fail('API_DRIFT', null), fail('TIMEOUT', null)]) {
      const { next, events } = evaluate(populated('HEALTHY'), run, ctx());
      expect(next).toEqual(populated('HEALTHY'));
      expect(events).toMatchObject([{ type: 'admin_queue', reason: 'unclassified' }]);
    }
  });
});

describe('row 8: BROKEN + FAIL, new signature -> BROKEN, signature_changed event on the open incident', () => {
  const broken = (over: Partial<ToolState> = {}) =>
    state({
      status: 'BROKEN',
      statusSince: ago(day),
      consecutiveFailures: 3,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
      ...over,
    });

  it('names the incident, the old and the new signature', () => {
    const { next, events } = evaluate(
      broken(),
      fail('DEPENDENCY_RESOLUTION', SIG_B),
      ctx({ openIncident: openIncident({ id: 'inc-7' }) }),
    );
    expect(next).toMatchObject({
      status: 'BROKEN',
      statusSince: ago(day),
      consecutiveFailures: 1,
      lastFailureSignature: SIG_B,
      lastFailureClass: 'DEPENDENCY_RESOLUTION',
    });
    expect(events).toEqual([
      {
        type: 'incident_signature_changed',
        incidentId: 'inc-7',
        from: SIG_A,
        to: SIG_B,
        failureClass: 'DEPENDENCY_RESOLUTION',
      },
    ]);
  });

  it('the same signature again just extends the streak: no event', () => {
    const { next, events } = evaluate(
      broken(),
      fail('API_DRIFT', SIG_A),
      ctx({ openIncident: openIncident() }),
    );
    expect(next).toMatchObject({ status: 'BROKEN', consecutiveFailures: 4 });
    expect(events).toEqual([]);
  });

  it('a transient failure while BROKEN is not a signature change', () => {
    expect(
      evaluate(broken(), fail('TIMEOUT', SIG_C), ctx({ openIncident: openIncident() })).events,
    ).toEqual([]);
  });

  it('BROKEN with no open incident (an inconsistency) opens one instead of losing the failure', () => {
    const { next, events } = evaluate(broken(), fail('API_DRIFT', SIG_A), ctx());
    expect(next.status).toBe('BROKEN');
    expect(events).toEqual([
      { type: 'incident_opened', failureClass: 'API_DRIFT', signature: SIG_A, trigger: 'repair' },
    ]);
  });

  it("the new signature is compared with the OPEN INCIDENT's, not only the last failure seen", () => {
    const s = broken({ lastFailureSignature: SIG_B });
    const { events } = evaluate(
      s,
      fail('API_DRIFT', SIG_B),
      ctx({ openIncident: openIncident({ signature: SIG_A }) }),
    );
    expect(events).toMatchObject([{ type: 'incident_signature_changed', from: SIG_A, to: SIG_B }]);
  });
});

describe('row 9: HEALTHY + FAIL with the signature of an incident resolved in the last 7 days -> BROKEN; reopen that incident, recurred event', () => {
  const healthy = () =>
    state({ status: 'HEALTHY', statusSince: ago(10 * day), consecutivePasses: 9 });

  it('reopens the incident straight away: one failure is enough', () => {
    const { next, events } = evaluate(
      healthy(),
      fail('API_DRIFT', SIG_A),
      ctx({ recentlyResolvedIncidents: [resolved({ id: 'inc-old' })] }),
    );
    expect(next).toMatchObject({
      status: 'BROKEN',
      statusSince: T,
      consecutivePasses: 0,
      consecutiveFailures: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    expect(events).toEqual([
      {
        type: 'incident_recurred',
        incidentId: 'inc-old',
        signature: SIG_A,
        failureClass: 'API_DRIFT',
      },
    ]);
  });

  it('a signature that matches nothing resolved is an ordinary first failure (row 2)', () => {
    const { next, events } = evaluate(
      healthy(),
      fail('API_DRIFT', SIG_B),
      ctx({ recentlyResolvedIncidents: [resolved()] }),
    );
    expect(next.status).toBe('DEGRADED');
    expect(events).toEqual([]);
  });

  it('exactly 7 days after the resolution still counts; 7 days and a millisecond does not', () => {
    const edge = evaluate(
      healthy(),
      fail('API_DRIFT', SIG_A),
      ctx({ recentlyResolvedIncidents: [resolved({ resolvedAt: ago(7 * day) })] }),
    );
    expect(edge.next.status).toBe('BROKEN');
    const late = evaluate(
      healthy(),
      fail('API_DRIFT', SIG_A),
      ctx({ recentlyResolvedIncidents: [resolved({ resolvedAt: ago(7 * day + 1) })] }),
    );
    expect(late.next.status).toBe('DEGRADED');
    expect(late.events).toEqual([]);
  });

  it('with several matches the most recently resolved incident is the one reopened', () => {
    const { events } = evaluate(
      healthy(),
      fail('API_DRIFT', SIG_A),
      ctx({
        recentlyResolvedIncidents: [
          resolved({ id: 'older', resolvedAt: ago(5 * day) }),
          resolved({ id: 'newest', resolvedAt: ago(1 * day) }),
          resolved({ id: 'middle', resolvedAt: ago(3 * day) }),
        ],
      }),
    );
    expect(events).toMatchObject([{ type: 'incident_recurred', incidentId: 'newest' }]);
  });

  it('a clock-skewed resolution time in the future still counts as recent', () => {
    const { next } = evaluate(
      healthy(),
      fail('API_DRIFT', SIG_A),
      ctx({
        recentlyResolvedIncidents: [
          resolved({ resolvedAt: new Date(Date.parse(T) + 60_000).toISOString() }),
        ],
      }),
    );
    expect(next.status).toBe('BROKEN');
  });

  it('applies to a transient failure whose incident was resolved (4 in a row earlier)', () => {
    const { next, events } = evaluate(
      healthy(),
      fail('NETWORK_TRANSIENT', SIG_C),
      ctx({ recentlyResolvedIncidents: [resolved({ signature: SIG_C })] }),
    );
    expect(next).toMatchObject({ status: 'BROKEN', transientStreak: 1 });
    expect(types(events)).toEqual(['incident_recurred']);
  });

  it('only a HEALTHY tool recurs; other statuses follow their own rows', () => {
    for (const from of ['UNKNOWN', 'DEGRADED', 'BROKEN'] as const) {
      const { events } = evaluate(
        state({ status: from, lastFailureSignature: null }),
        fail('API_DRIFT', SIG_A),
        ctx({
          recentlyResolvedIncidents: [resolved()],
          openIncident: from === 'BROKEN' ? openIncident({ signature: SIG_A }) : null,
        }),
      );
      expect(types(events), from).not.toContain('incident_recurred');
    }
  });

  it('never when an incident is already open: there can be only one open incident per tool', () => {
    const { events } = evaluate(
      healthy(),
      fail('API_DRIFT', SIG_A),
      ctx({
        openIncident: openIncident({ signature: SIG_C }),
        recentlyResolvedIncidents: [resolved()],
      }),
    );
    expect(types(events)).not.toContain('incident_recurred');
  });
});

describe('invalid cycles produce no transitions', () => {
  const runs: [string, StatusRun][] = [
    ['PASS', pass()],
    ['vendor FAIL', fail('API_DRIFT')],
    ['transient FAIL', fail('TIMEOUT')],
    ['admin class', fail('UNKNOWN')],
    [
      'SKIPPED',
      fail('NEEDS_CREDENTIALS', SIG_A, { outcome: 'SKIPPED', skipReason: 'manual_step' }),
    ],
    ['HARNESS_ERROR', fail('HARNESS_ERROR', null, { outcome: 'HARNESS_ERROR' })],
  ];
  it.each(runs)('%s: state untouched, a single cycle_ignored note', (_name, run) => {
    for (const status of TOOL_STATUSES) {
      const s = state({
        status,
        consecutiveFailures: 1,
        consecutivePasses: 1,
        transientStreak: 3,
        lastFailureSignature: SIG_A,
        lastFailureClass: 'API_DRIFT',
      });
      const { next, events } = evaluate(
        s,
        run,
        ctx({
          cycleValid: false,
          openIncident: openIncident(),
          recentlyResolvedIncidents: [resolved()],
        }),
      );
      expect(next).toEqual(s);
      expect(events).toEqual([{ type: 'cycle_ignored', note: expect.any(String) }]);
    }
  });
});

describe('idempotence', () => {
  it('the same inputs always give the same output', () => {
    const s = state({
      status: 'DEGRADED',
      consecutiveFailures: 1,
      lastFailureSignature: SIG_A,
      lastFailureClass: 'API_DRIFT',
    });
    const run = fail('API_DRIFT', SIG_A);
    expect(evaluate(s, run, ctx())).toEqual(evaluate(s, run, ctx()));
  });

  it('feeding the same failing run again after the incident opened does not open a second incident', () => {
    const run = fail('API_DRIFT', SIG_A);
    const first = evaluate(
      state({
        status: 'DEGRADED',
        consecutiveFailures: 1,
        lastFailureSignature: SIG_A,
        lastFailureClass: 'API_DRIFT',
      }),
      run,
      ctx(),
    );
    expect(types(first.events)).toEqual(['incident_opened']);
    const again = evaluate(
      first.next,
      run,
      ctx({ openIncident: openIncident({ signature: SIG_A }) }),
    );
    expect(types(again.events)).toEqual([]);
    expect(again.next.status).toBe('BROKEN');
  });

  it('the same for a transient incident: a 5th failure in a row opens nothing more', () => {
    const run = fail('NETWORK_TRANSIENT', SIG_C);
    const opened = evaluate(state({ status: 'DEGRADED', transientStreak: 3 }), run, ctx());
    expect(types(opened.events)).toEqual(['incident_opened']);
    const fifth = evaluate(
      opened.next,
      run,
      ctx({ openIncident: openIncident({ signature: SIG_C, failureClass: 'NETWORK_TRANSIENT' }) }),
    );
    expect(types(fifth.events)).toEqual([]);
  });

  it('replaying a resolving pass does not resolve twice: the API passes the open incident, and there is none after', () => {
    const s = state({ status: 'BROKEN', consecutivePasses: 1 });
    const first = evaluate(s, pass(), ctx({ openIncident: openIncident() }));
    expect(types(first.events)).toEqual(['incident_resolved']);
    expect(types(evaluate(first.next, pass(), ctx()).events)).toEqual([]);
  });
});

describe('immutability', () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
  };

  it('never mutates the state, the run or the context (frozen inputs would throw), and returns a new object', () => {
    const s = deepFreeze(
      state({
        status: 'DEGRADED',
        consecutiveFailures: 1,
        lastFailureSignature: SIG_A,
        lastFailureClass: 'API_DRIFT',
      }),
    );
    const c = deepFreeze(
      ctx({ openIncident: openIncident(), recentlyResolvedIncidents: [resolved()] }),
    );
    for (const run of [
      pass(),
      fail('API_DRIFT', SIG_A),
      fail('API_DRIFT', SIG_B),
      fail('TIMEOUT', SIG_C),
      fail('UNKNOWN', SIG_C),
    ]) {
      const r = evaluate(s, deepFreeze(run), c);
      expect(r.next).not.toBe(s);
    }
    expect(evaluate(s, deepFreeze(pass()), deepFreeze(ctx({ cycleValid: false }))).next).not.toBe(
      s,
    );
  });

  it('the state it was given is unchanged afterwards', () => {
    const s = state({ status: 'HEALTHY', consecutivePasses: 3 });
    const snapshot = structuredClone(s);
    evaluate(s, fail('API_DRIFT', SIG_A), ctx());
    expect(s).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------------------------
describe('totality: evaluate is defined for EVERY combination (status x outcome/class x signature relation x cycleValid)', () => {
  type Relation =
    | 'none'
    | 'sameAsLast'
    | 'differsFromLast'
    | 'matchesRecentResolved'
    | 'matchesOldResolved'
    | 'equalsOpen'
    | 'differsFromOpen';
  const RELATIONS: Relation[] = [
    'none',
    'sameAsLast',
    'differsFromLast',
    'matchesRecentResolved',
    'matchesOldResolved',
    'equalsOpen',
    'differsFromOpen',
  ];

  const runKinds: { name: string; make: (sig: string | null) => StatusRun }[] = [
    { name: 'PASS', make: () => pass() },
    {
      name: 'SKIPPED manual',
      make: (sig) =>
        fail('NEEDS_CREDENTIALS', sig, {
          outcome: 'SKIPPED',
          skipReason: 'manual_step',
          reachedLevel: 0,
        }),
    },
    { name: 'SKIPPED other', make: () => fail(null, null, { outcome: 'SKIPPED' }) },
    {
      name: 'HARNESS_ERROR outcome',
      make: (sig) => fail('HARNESS_ERROR', sig, { outcome: 'HARNESS_ERROR' }),
    },
    { name: 'FAIL null class', make: (sig) => fail(null, sig) },
    ...FAILURE_CLASSES.map((c) => ({
      name: `FAIL ${c}`,
      make: (sig: string | null) => fail(c, sig),
    })),
  ];

  const sigFor = (relation: Relation): string | null =>
    relation === 'none'
      ? null
      : relation === 'differsFromLast' || relation === 'differsFromOpen'
        ? SIG_C
        : SIG_A;

  function contextFor(relation: Relation, cycleValid: boolean, withOpen: boolean): StatusContext {
    const open =
      relation === 'equalsOpen'
        ? openIncident({ signature: SIG_A })
        : relation === 'differsFromOpen'
          ? openIncident({ signature: SIG_B })
          : null;
    return ctx({
      cycleValid,
      openIncident: open ?? (withOpen ? openIncident({ signature: SIG_B }) : null),
      recentlyResolvedIncidents:
        relation === 'matchesRecentResolved'
          ? [resolved({ signature: SIG_A })]
          : relation === 'matchesOldResolved'
            ? [resolved({ signature: SIG_A, resolvedAt: ago(30 * day) })]
            : [],
      previousReachedLevel: 3,
    });
  }

  const streaks: Partial<ToolState>[] = [
    {},
    { consecutiveFailures: 1, lastFailureSignature: SIG_A, lastFailureClass: 'API_DRIFT' },
    {
      consecutiveFailures: 3,
      consecutivePasses: 1,
      lastFailureSignature: SIG_B,
      lastFailureClass: 'DEPENDENCY_RESOLUTION',
    },
    { transientStreak: 3 },
    { consecutivePasses: 1, transientStreak: 1 },
  ];

  const cases: { name: string; s: ToolState; run: StatusRun; c: StatusContext }[] = [];
  for (const status of TOOL_STATUSES)
    for (const streak of streaks)
      for (const kind of runKinds)
        for (const relation of RELATIONS)
          for (const cycleValid of [true, false])
            for (const withOpen of [false, true])
              cases.push({
                name: `${status} ${JSON.stringify(streak)} ${kind.name} ${relation} valid=${cycleValid} open=${withOpen}`,
                s: state({
                  status,
                  statusSince: status === 'UNKNOWN' ? null : ago(day),
                  ...streak,
                }),
                run: kind.make(sigFor(relation)),
                c: contextFor(relation, cycleValid, withOpen),
              });

  it('covers a large space', () => {
    expect(cases.length).toBeGreaterThan(8_000);
  });

  it('never throws, always returns a valid state and valid events, and keeps the invariants', () => {
    const failures: string[] = [];
    for (const { name, s, run, c } of cases) {
      let result: ReturnType<typeof evaluate>;
      try {
        result = evaluate(s, run, c);
      } catch (error) {
        failures.push(`${name}: threw ${String(error)}`);
        continue;
      }
      const { next, events } = result;
      const problems: string[] = [];
      if (!ToolState.safeParse(next).success) problems.push('next is not a valid ToolState');
      for (const e of events)
        if (!StatusEvent.safeParse(e).success) problems.push(`invalid event ${JSON.stringify(e)}`);
      const incidentEvents = events.filter((e) => e.type.startsWith('incident_'));
      const admin = events.filter((e) => e.type === 'admin_queue');
      if (incidentEvents.length > 1) problems.push('more than one incident event');
      if (admin.length > 1) problems.push('more than one admin_queue event');
      if (incidentEvents.length > 0 && admin.length > 0)
        problems.push('incident and admin_queue together');

      if (!c.cycleValid) {
        if (JSON.stringify(next) !== JSON.stringify(s))
          problems.push('an invalid cycle changed the state');
        if (events.length !== 1 || events[0]?.type !== 'cycle_ignored')
          problems.push('an invalid cycle must give exactly one cycle_ignored');
      } else {
        if (events.some((e) => e.type === 'cycle_ignored'))
          problems.push('cycle_ignored in a valid cycle');
        if (admin.length > 0 && JSON.stringify(next) !== JSON.stringify(s))
          problems.push('admin_queue must not change the state');
        for (const e of events) {
          if (e.type === 'incident_opened' && (next.status !== 'BROKEN' || c.openIncident !== null))
            problems.push('incident_opened without becoming BROKEN, or with one already open');
          if (
            e.type === 'incident_resolved' &&
            (next.status !== 'HEALTHY' || run.outcome !== 'PASS' || c.openIncident === null)
          )
            problems.push('incident_resolved outside a recovery');
          if (
            e.type === 'incident_signature_changed' &&
            (s.status !== 'BROKEN' || next.status !== 'BROKEN')
          )
            problems.push('signature_changed outside BROKEN');
          if (
            e.type === 'incident_recurred' &&
            (s.status !== 'HEALTHY' || next.status !== 'BROKEN' || c.openIncident !== null)
          )
            problems.push('recurred outside HEALTHY -> BROKEN');
        }
        if (run.outcome !== 'PASS' && s.status === 'BROKEN' && next.status !== 'BROKEN')
          problems.push('a failure moved a BROKEN tool out of BROKEN');
        if (s.status !== next.status && next.statusSince !== run.finishedAt)
          problems.push('status changed but status_since did not');
        if (s.status === next.status && next.statusSince !== s.statusSince)
          problems.push('status_since moved without a status change');
        if (
          next.status === 'BROKEN' &&
          s.status !== 'BROKEN' &&
          !events.some((e) => e.type === 'incident_opened' || e.type === 'incident_recurred') &&
          c.openIncident === null
        )
          problems.push('became BROKEN without opening or reopening an incident');
        if (run.outcome === 'PASS' && next.status === 'BROKEN' && s.status !== 'BROKEN')
          problems.push('a pass made a tool BROKEN');
        if (
          run.outcome === 'PASS' &&
          (next.consecutivePasses !== s.consecutivePasses + 1 ||
            next.consecutiveFailures !== 0 ||
            next.transientStreak !== 0)
        )
          problems.push('a pass must count itself and clear the streaks');
      }
      if (JSON.stringify(evaluate(s, run, c)) !== JSON.stringify(result))
        problems.push('not deterministic');
      if (problems.length > 0) failures.push(`${name}: ${problems.join('; ')}`);
    }
    expect(failures.slice(0, 15)).toEqual([]);
  });
});
