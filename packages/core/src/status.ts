import { z } from 'zod';
import { SkipReason } from './run-result.js';
import { FailureClass, RunOutcome, ToolStatus } from './taxonomy.js';

// Spec section 10, status engine: `evaluate(tool, run, cycleValid) -> { nextTool, events }`. These are
// its data types, shared by packages/status (the pure function) and apps/api (which loads them from the
// database, calls evaluate at cycle finish and applies the events in one transaction).

/** The part of a tool row the engine reads and writes (`tools` table, spec section 5). */
export const ToolState = z.object({
  status: ToolStatus,
  /** When `status` last changed; null before the first run. */
  statusSince: z.iso.datetime().nullable(),
  /** Consecutive failures with the SAME signature (vendor classes). */
  consecutiveFailures: z.number().int().min(0),
  consecutivePasses: z.number().int().min(0),
  /** Consecutive NETWORK_TRANSIENT / TIMEOUT failures: 4 in a row open an incident. */
  transientStreak: z.number().int().min(0),
  lastFailureSignature: z.string().nullable(),
  lastFailureClass: FailureClass.nullable(),
  /**
   * The harness version the last counted failure ran under. Failures under different versions are never consecutive. Null while no
   * failure is counted, and also on a tool whose failure was recorded before versioning existed: that is version 1.
   */
  lastFailureHarnessVersion: z.number().int().min(1).nullable(),
});
export type ToolState = z.infer<typeof ToolState>;

/** What the engine needs to know about one (final-attempt) run. */
export const StatusRun = z.object({
  outcome: RunOutcome,
  /** The classifier's class for a failed run; null for a PASS. */
  failureClass: FailureClass.nullable(),
  /** The classifier's signature for a failed run; null for a PASS. */
  failureSignature: z.string().nullable(),
  reachedLevel: z.number().int().min(0).max(4),
  skipReason: SkipReason.nullable(),
  /** The harness version that produced this run (see HARNESS_VERSION). */
  harnessVersion: z.number().int().min(1),
  finishedAt: z.iso.datetime(),
});
export type StatusRun = z.infer<typeof StatusRun>;

export const OpenIncident = z.object({
  id: z.string(),
  signature: z.string(),
  failureClass: FailureClass,
});
export type OpenIncident = z.infer<typeof OpenIncident>;

export const ResolvedIncident = z.object({
  id: z.string(),
  signature: z.string(),
  resolvedAt: z.iso.datetime(),
});
export type ResolvedIncident = z.infer<typeof ResolvedIncident>;

/** Facts about the world the engine cannot derive from the tool row. */
export const StatusContext = z.object({
  /** The cycle's canaries passed (spec section 10): an invalid cycle produces no transitions. */
  cycleValid: z.boolean(),
  /** The tool's open incident, if any (at most one: the `one_open_incident_per_tool` index). */
  openIncident: OpenIncident.nullable(),
  /** Incidents resolved recently; the engine itself applies the 7-day window to `run.finishedAt`. */
  recentlyResolvedIncidents: z.array(ResolvedIncident),
  /** The level the tool's previous run reached, to notice a plan that regressed. Null when unknown. */
  previousReachedLevel: z.number().int().min(0).max(4).nullable(),
});
export type StatusContext = z.infer<typeof StatusContext>;

export const ADMIN_QUEUE_REASONS = [
  'crawl_error',
  'compiler_error',
  'harness_error',
  'needs_credentials',
  'unknown_failure',
  'skipped',
  'plan_regressed',
  'unclassified',
] as const;
export const AdminQueueReason = z.enum(ADMIN_QUEUE_REASONS);
export type AdminQueueReason = z.infer<typeof AdminQueueReason>;

export const INCIDENT_TRIGGERS = ['repeat_failure', 'transient_streak', 'repair'] as const;
export const IncidentTrigger = z.enum(INCIDENT_TRIGGERS);
export type IncidentTrigger = z.infer<typeof IncidentTrigger>;

/** Effects the API applies; the engine itself touches nothing. */
export const StatusEvent = z.discriminatedUnion('type', [
  /** Open an incident (PENDING_REVIEW). `repair`: the tool is BROKEN but no incident is open. */
  z.object({
    type: z.literal('incident_opened'),
    failureClass: FailureClass,
    signature: z.string(),
    trigger: IncidentTrigger,
  }),
  /** The tool recovered: resolve the open incident. */
  z.object({ type: z.literal('incident_resolved'), incidentId: z.string() }),
  /** The failure changed shape while BROKEN: `signature_changed` on the open incident. */
  z.object({
    type: z.literal('incident_signature_changed'),
    incidentId: z.string(),
    from: z.string(),
    to: z.string(),
    failureClass: FailureClass,
  }),
  /** A failure with the signature of an incident resolved in the last 7 days: reopen it, `recurred`. */
  z.object({
    type: z.literal('incident_recurred'),
    incidentId: z.string(),
    signature: z.string(),
    failureClass: FailureClass,
  }),
  /** Something for a person to look at; never an incident, never a status change. */
  z.object({
    type: z.literal('admin_queue'),
    reason: AdminQueueReason,
    failureClass: FailureClass.nullable(),
    signature: z.string().nullable(),
    detail: z.string(),
  }),
  /** The cycle was not valid: nothing was applied. */
  z.object({ type: z.literal('cycle_ignored'), note: z.string() }),
]);
export type StatusEvent = z.infer<typeof StatusEvent>;

export interface Evaluation {
  next: ToolState;
  events: StatusEvent[];
}

/** A tool no run has touched yet. */
export const INITIAL_TOOL_STATE: ToolState = {
  status: 'UNKNOWN',
  statusSince: null,
  consecutiveFailures: 0,
  consecutivePasses: 0,
  transientStreak: 0,
  lastFailureSignature: null,
  lastFailureClass: null,
  lastFailureHarnessVersion: null,
};

/** Resolved incidents older than this no longer count as a recurrence (spec section 10). */
export const RECURRENCE_WINDOW_DAYS = 7;
/** Spec section 10: "4 in a row" transient failures open an incident. */
export const TRANSIENT_INCIDENT_STREAK = 4;
/**
 * Spec section 10: the same vendor failure signature this many times in a row (the first moves the tool to
 * DEGRADED, the next opens an incident). The engine encodes it as the DEGRADED to BROKEN row; a status test pins
 * that every such transition lands on this count.
 */
export const FAILURES_TO_OPEN_INCIDENT = 2;
/** Spec section 10: HEALTHY again once consecutive_passes reaches 2. */
export const PASSES_TO_RECOVER = 2;
