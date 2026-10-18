import {
  PASSES_TO_RECOVER,
  RECURRENCE_WINDOW_DAYS,
  TRANSIENT_FAILURE_CLASSES,
  TRANSIENT_INCIDENT_STREAK,
  VENDOR_FAILURE_CLASSES,
  type AdminQueueReason,
  type Evaluation,
  type FailureClass,
  type StatusContext,
  type StatusEvent,
  type StatusRun,
  type ToolState,
} from '@qsr/core';

// Spec section 10, "Status engine": a pure function, no I/O and no clock (time is `run.finishedAt`).
//
//   evaluate(state, run, ctx) -> { next, events }
//
// The API loads the tool row and its open/recently resolved incidents, calls this once per run at cycle
// finish, and applies `next` and `events` in one transaction. Nothing here can open an incident by
// itself: it only says that one should be opened.
//
// The transition table (spec rows, in order) is implemented in `pass`, `vendorFailure`,
// `transientFailure`, the recurrence check, and `queue`; each is labelled with its row.

const DAY_MS = 24 * 60 * 60 * 1000;

const isVendor = (c: FailureClass): boolean =>
  (VENDOR_FAILURE_CLASSES as readonly string[]).includes(c);
const isTransient = (c: FailureClass): boolean =>
  (TRANSIENT_FAILURE_CLASSES as readonly string[]).includes(c);

/** Classes that never change a status and never open an incident: they go to the admin queue. */
const ADMIN_REASON: Partial<Record<FailureClass, AdminQueueReason>> = {
  CRAWL_ERROR: 'crawl_error',
  COMPILER_ERROR: 'compiler_error',
  HARNESS_ERROR: 'harness_error',
  NEEDS_CREDENTIALS: 'needs_credentials',
  UNKNOWN: 'unknown_failure',
};

const result = (next: ToolState, events: StatusEvent[] = []): Evaluation => ({ next, events });

/**
 * Harness versions (P9d). A failure counts toward "the same failure twice in a row" (or four transient failures in a row) only
 * if it ran under the same version of the harness checks as the failure before it: a stricter or fixed check can make an old
 * observation and a new one disagree about the same quickstart, and that is not a streak. A tool whose last failure was recorded
 * before versioning existed has no stored version; that failure was made by version 1.
 */
function priorHarnessVersion(state: ToolState): number | null {
  if (state.lastFailureHarnessVersion !== null) return state.lastFailureHarnessVersion;
  const remembersAFailure =
    state.lastFailureSignature !== null ||
    state.consecutiveFailures > 0 ||
    state.transientStreak > 0;
  return remembersAFailure ? 1 : null;
}

/** The state a failure is compared with: the streak is forgotten when the previous failure ran under another version. */
function comparableState(state: ToolState, run: StatusRun): ToolState {
  const prior = priorHarnessVersion(state);
  return prior !== null && prior !== run.harnessVersion
    ? { ...state, consecutiveFailures: 0, transientStreak: 0, lastFailureSignature: null }
    : state;
}

/** Every counted failure records the version it ran under; nothing else about the evaluation changes. */
const recordVersion = (e: Evaluation, run: StatusRun): Evaluation => ({
  ...e,
  next: { ...e.next, lastFailureHarnessVersion: run.harnessVersion },
});

/** Row 7 and the clarifications: unchanged state, one admin queue item. */
function queue(
  state: ToolState,
  reason: AdminQueueReason,
  run: StatusRun,
  detail: string,
): Evaluation {
  return result({ ...state }, [
    {
      type: 'admin_queue',
      reason,
      failureClass: run.failureClass,
      signature: run.failureSignature,
      detail,
    },
  ]);
}

/** Row 1. */
function pass(state: ToolState, run: StatusRun, ctx: StatusContext): Evaluation {
  const counted: ToolState = {
    ...state,
    consecutivePasses: state.consecutivePasses + 1,
    consecutiveFailures: 0,
    transientStreak: 0,
  };
  const recovered: ToolState = {
    ...counted,
    status: 'HEALTHY',
    statusSince: run.finishedAt,
    lastFailureSignature: null,
    lastFailureClass: null,
    lastFailureHarnessVersion: null,
  };
  const resolve: StatusEvent[] = ctx.openIncident
    ? [{ type: 'incident_resolved', incidentId: ctx.openIncident.id }]
    : [];

  switch (state.status) {
    case 'UNKNOWN': // immediately from UNKNOWN
    case 'DEGRADED': // immediately: no incident exists yet, so there is nothing to wait out
      return result(recovered, resolve);
    case 'HEALTHY':
      return result({
        ...counted,
        lastFailureSignature: null,
        lastFailureClass: null,
        lastFailureHarnessVersion: null,
      });
    case 'BROKEN':
      // The status does not change until the second consecutive pass.
      return counted.consecutivePasses >= PASSES_TO_RECOVER
        ? result(recovered, resolve)
        : result(counted);
  }
}

/** Row 9: the signature of an incident resolved in the last 7 days, seen again on a HEALTHY tool. */
function recurrence(
  state: ToolState,
  run: StatusRun,
  signature: string,
  failureClass: FailureClass,
  ctx: StatusContext,
): Evaluation | null {
  if (state.status !== 'HEALTHY' || ctx.openIncident !== null) return null;
  const now = Date.parse(run.finishedAt);
  const match = ctx.recentlyResolvedIncidents
    .filter(
      (i) =>
        i.signature === signature &&
        now - Date.parse(i.resolvedAt) <= RECURRENCE_WINDOW_DAYS * DAY_MS,
    )
    .sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt))[0];
  if (!match) return null;
  return result(
    {
      ...state,
      status: 'BROKEN',
      statusSince: run.finishedAt,
      consecutivePasses: 0,
      consecutiveFailures: 1,
      transientStreak: isTransient(failureClass) ? 1 : 0,
      lastFailureSignature: signature,
      lastFailureClass: failureClass,
    },
    [{ type: 'incident_recurred', incidentId: match.id, signature, failureClass }],
  );
}

/** Rows 2, 3, 4 and 8: a failure the vendor owns. */
function vendorFailure(
  state: ToolState,
  run: StatusRun,
  signature: string,
  failureClass: FailureClass,
  ctx: StatusContext,
): Evaluation {
  const base: ToolState = {
    ...state,
    consecutivePasses: 0,
    transientStreak: 0,
    lastFailureSignature: signature,
    lastFailureClass: failureClass,
  };
  const open: StatusEvent = {
    type: 'incident_opened',
    failureClass,
    signature,
    trigger: 'repeat_failure',
  };

  switch (state.status) {
    case 'UNKNOWN':
    case 'HEALTHY': // row 2: the first failure
      return result({
        ...base,
        status: 'DEGRADED',
        statusSince: run.finishedAt,
        consecutiveFailures: 1,
      });
    case 'DEGRADED':
      if (state.lastFailureSignature === signature) {
        // row 3: the same signature twice in a row
        return result(
          {
            ...base,
            status: 'BROKEN',
            statusSince: run.finishedAt,
            consecutiveFailures: state.consecutiveFailures + 1,
          },
          ctx.openIncident ? [] : [open],
        );
      }
      // row 4: a different signature restarts the streak
      return result({ ...base, consecutiveFailures: 1 });
    case 'BROKEN': {
      if (!ctx.openIncident)
        // BROKEN with no open incident should not exist; open one rather than lose the failure
        return result(
          {
            ...base,
            consecutiveFailures:
              state.lastFailureSignature === signature ? state.consecutiveFailures + 1 : 1,
          },
          [{ ...open, trigger: 'repair' }],
        );
      if (ctx.openIncident.signature !== signature)
        // row 8: the failure changed shape while BROKEN
        return result({ ...base, consecutiveFailures: 1 }, [
          {
            type: 'incident_signature_changed',
            incidentId: ctx.openIncident.id,
            from: ctx.openIncident.signature,
            to: signature,
            failureClass,
          },
        ]);
      return result({ ...base, consecutiveFailures: state.consecutiveFailures + 1 });
    }
  }
}

/** Rows 5 and 6: NETWORK_TRANSIENT / TIMEOUT. Only 4 in a row open an incident. */
function transientFailure(
  state: ToolState,
  run: StatusRun,
  signature: string,
  failureClass: FailureClass,
  ctx: StatusContext,
): Evaluation {
  const streak = state.transientStreak + 1;
  const counted: ToolState = { ...state, consecutivePasses: 0, transientStreak: streak };

  if (streak >= TRANSIENT_INCIDENT_STREAK) {
    // row 6
    const opened: StatusEvent = {
      type: 'incident_opened',
      failureClass,
      signature,
      trigger: state.status === 'BROKEN' ? 'repair' : 'transient_streak',
    };
    if (state.status === 'BROKEN') return result(counted, ctx.openIncident ? [] : [opened]);
    return result(
      {
        ...counted,
        status: 'BROKEN',
        statusSince: run.finishedAt,
        lastFailureSignature: signature,
        lastFailureClass: failureClass,
      },
      ctx.openIncident ? [] : [opened],
    );
  }
  // row 5: unchanged, or DEGRADED from HEALTHY
  return state.status === 'HEALTHY'
    ? result({ ...counted, status: 'DEGRADED', statusSince: run.finishedAt })
    : result(counted);
}

export function evaluate(state: ToolState, run: StatusRun, ctx: StatusContext): Evaluation {
  if (!ctx.cycleValid)
    return result({ ...state }, [
      {
        type: 'cycle_ignored',
        note: 'the cycle is not valid (its canaries did not behave): no transition was applied',
      },
    ]);

  if (run.outcome === 'PASS') return pass(state, run, ctx);

  if (run.outcome === 'SKIPPED') {
    const regressed =
      run.skipReason === 'manual_step' &&
      ctx.previousReachedLevel !== null &&
      ctx.previousReachedLevel > run.reachedLevel;
    return regressed
      ? queue(
          state,
          'plan_regressed',
          run,
          `the plan used to reach L${String(ctx.previousReachedLevel)} and now stops at L${run.reachedLevel} because of a manual step`,
        )
      : queue(
          state,
          'skipped',
          run,
          `the run was skipped (${run.skipReason ?? 'no reason recorded'})`,
        );
  }

  if (run.outcome === 'HARNESS_ERROR')
    return queue(state, 'harness_error', run, 'the run ended in a harness error');

  const cls = run.failureClass;
  if (cls === null) return queue(state, 'unclassified', run, 'a failed run with no failure class');
  const reason = ADMIN_REASON[cls];
  if (reason)
    return queue(state, reason, run, `${cls}: for a person to look at, never an incident`);
  if (run.failureSignature === null)
    return queue(
      state,
      'unclassified',
      run,
      `${cls} without a signature cannot be compared with earlier failures`,
    );

  const compared = comparableState(state, run);
  return recordVersion(
    recurrence(compared, run, run.failureSignature, cls, ctx) ??
      (isVendor(cls)
        ? vendorFailure(compared, run, run.failureSignature, cls, ctx)
        : transientFailure(compared, run, run.failureSignature, cls, ctx)),
    run,
  );
}
