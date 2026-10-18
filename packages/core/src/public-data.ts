import { z } from 'zod';
import { ExtractionBlock, Truncation } from './extraction.js';
import { GroundingReport, StepIR } from './step-ir.js';
import {
  FailureClass,
  IncidentState,
  Language,
  ReviewState,
  RunOutcome,
  ToolStatus,
} from './taxonomy.js';

// What the public website reads (spec section 13) and the rules that decide what it may show. Browser-safe:
// zod and plain functions only, so server components, client components and tests all share one definition.
//
// The rule that matters most: an unreviewed failure shows "verifying" and NO cause text. The database views
// enforce it (migration 0006); `confirmedOnly` and `sanitizeRun` enforce it again in the app, so a mistake in
// either layer alone cannot leak a cause.

const Uuid = z.uuid();
const Timestamp = z.string().min(1); // PostgREST sends timestamptz as an ISO-like string
/** PostgREST sends `numeric` as a number or a string depending on the value; the app wants a number. */
const NumericOrNull = z
  .union([z.number(), z.string()])
  .nullable()
  .transform((v) => (v === null ? null : Number(v)));

// ---- public_tools
export const PublicToolRow = z.object({
  slug: z.string(),
  name: z.string(),
  docs_url: z.string(),
  language: Language,
  level: z.number().int(),
  status: ToolStatus,
  status_since: Timestamp.nullable(),
  last_run_at: Timestamp.nullable(),
  pass_rate_30d: NumericOrNull,
  // null when the vendor opted out and asked for its past results to be hidden (the view blanks every result column)
  current_streak: z.number().int().nullable(),
  streak_kind: z.enum(['pass', 'fail']).nullable(),
  last_run_id: Uuid.nullable(),
  last_outcome: RunOutcome.nullable(),
  last_reached_level: z.number().int().nullable(),
  last_skip_reason: z.string().nullable(),
  decided_30d: z.coerce.number().int(),
  // A vendor opt-out (migration 0009): when probing stopped, and whether the vendor also asked for the past results to be hidden.
  // Defaults, so a database that has not applied 0009 yet still parses.
  opted_out_at: Timestamp.nullable().default(null),
  history_hidden: z.boolean().default(false),
});
export type PublicToolRow = z.infer<typeof PublicToolRow>;

// ---- public_run_history: one light row per (cycle, tool), newest first
export const RUN_KINDS = ['pass', 'fail', 'not_run', 'harness', 'skipped'] as const;
export const RunKind = z.enum(RUN_KINDS);
export type RunKind = z.infer<typeof RunKind>;
export const PublicRunHistoryRow = z.object({
  run_id: Uuid,
  tool_slug: z.string(),
  started_at: Timestamp,
  outcome: RunOutcome,
  kind: RunKind,
  reached_level: z.number().int(),
  target_level: z.number().int(),
  stale: z.boolean(),
  duration_ms: z.number().int(),
  rn: z.coerce.number().int(),
});
export type PublicRunHistoryRow = z.infer<typeof PublicRunHistoryRow>;

// ---- public_incidents
export const VersionDiff = z.object({
  changed: z.array(z.object({ name: z.string(), from: z.string(), to: z.string() })).default([]),
  added: z.array(z.object({ name: z.string(), version: z.string() })).default([]),
  removed: z.array(z.object({ name: z.string(), version: z.string() })).default([]),
});
export type VersionDiff = z.infer<typeof VersionDiff>;

export const PublicIncidentRow = z.object({
  id: Uuid,
  tool_slug: z.string(),
  tool_name: z.string(),
  signature: z.string(),
  failure_class: FailureClass,
  state: IncidentState,
  review: ReviewState,
  first_failing_run_id: Uuid.nullable(),
  last_passing_run_id: Uuid.nullable(),
  docs_changed: z.boolean().nullable(),
  docs_diff_path: z.string().nullable(),
  summary: z.string().nullable(),
  suggested_fix: z.string().nullable(),
  opened_at: Timestamp,
  confirmed_at: Timestamp.nullable(),
  resolved_at: Timestamp.nullable(),
  events: z.array(
    z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()), at: Timestamp }),
  ),
  version_diff: VersionDiff.nullable(),
});
export type PublicIncidentRow = z.infer<typeof PublicIncidentRow>;

// ---- public_runs (the detail of one run)
export const PublicStepRow = z.object({
  step_id: z.string(),
  ordinal: z.number().int(),
  kind: z.string(),
  outcome: z.string(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int(),
  stdout_tail: z.string().nullable(),
  stderr_tail: z.string().nullable(),
  log_path: z.string().nullable(),
});
export type PublicStepRow = z.infer<typeof PublicStepRow>;

export const PublicRunRow = z.object({
  id: Uuid,
  tool_slug: z.string(),
  cycle_id: Uuid,
  attempt: z.number().int(),
  outcome: RunOutcome,
  failure_class: FailureClass.nullable(),
  failure_signature: z.string().nullable(),
  failed_step_id: z.string().nullable(),
  image_digest: z.string(),
  runner_env: z.record(z.string(), z.string()),
  duration_ms: z.number().int(),
  started_at: Timestamp,
  finished_at: Timestamp,
  snapshot_hash: z.string().nullable(),
  // The plan is parsed leniently: a plan from an older compiler version must still render.
  plan_ir: StepIR.nullable().catch(null),
  grounding_report: GroundingReport.nullable().catch(null),
  steps: z.array(PublicStepRow),
  details_published: z.boolean(),
  reached_level: z.number().int(),
  skip_reason: z.string().nullable(),
  plan_compiler_version: z.string().nullable(),
  plan_truncation: Truncation.nullable().catch(null),
  plan_stale: z.boolean(),
  /** The version of the checks that produced the run (P9d): 1 is everything before versioning. */
  harness_version: z.number().int().min(1).default(1),
  snapshot_blocks: z.array(ExtractionBlock).nullable().catch(null),
  snapshot_title: z.string().nullable(),
  snapshot_url: z.string().nullable(),
});
export type PublicRunRow = z.infer<typeof PublicRunRow>;

// ---- the one status shown everywhere
export const PUBLIC_STATUSES = [
  'passing',
  'failing',
  'verifying',
  'unknown',
  'needs_person',
] as const;
export type PublicStatus = (typeof PUBLIC_STATUSES)[number];

export interface StatusInput {
  status: ToolStatus;
  lastOutcome: RunOutcome | null;
  /** An OPEN incident that a person CONFIRMED. The only thing that may make a tool "failing". */
  hasConfirmedOpenIncident: boolean;
}

/**
 * The public status of a tool: one function for the page, the badge and the OG image. "failing" needs a
 * confirmed open incident, whatever the status string says; any other failure being looked at is "verifying".
 */
export function publicStatus(input: StatusInput): PublicStatus {
  if (input.hasConfirmedOpenIncident) return 'failing';
  if (input.lastOutcome === 'SKIPPED') return 'needs_person';
  if (input.status === 'DEGRADED' || input.status === 'BROKEN') return 'verifying';
  if (input.status === 'HEALTHY') return 'passing';
  return 'unknown';
}

/** A tool counts in "X of Y" when it ran and has a verdict, or one being verified. */
export const isTested = (s: PublicStatus): boolean =>
  s === 'passing' || s === 'failing' || s === 'verifying';

export interface Headline {
  passing: number;
  /** Y: tools that were tested (passing + failing + verifying). */
  tested: number;
  failing: number;
  verifying: number;
  needsPerson: number;
  notTested: number;
  /** Tested at L3 or above: the quickstart reached the vendor's API. */
  testedAtL3: number;
  /** Tested at L2: it installed and its code imports or compiles, but was not run against the vendor. */
  testedAtL2: number;
  /** Tested at L1: only the install commands ran. */
  testedAtL1: number;
  passingAtL3: number;
  passingAtL2: number;
  passingAtL1: number;
}

export function computeHeadline(
  tools: readonly { status: PublicStatus; level: number }[],
): Headline {
  const h: Headline = {
    passing: 0,
    tested: 0,
    failing: 0,
    verifying: 0,
    needsPerson: 0,
    notTested: 0,
    testedAtL3: 0,
    testedAtL2: 0,
    testedAtL1: 0,
    passingAtL3: 0,
    passingAtL2: 0,
    passingAtL1: 0,
  };
  for (const t of tools) {
    if (t.status === 'needs_person') h.needsPerson += 1;
    else if (t.status === 'unknown') h.notTested += 1;
    if (!isTested(t.status)) continue;
    h.tested += 1;
    if (t.status === 'passing') h.passing += 1;
    else if (t.status === 'failing') h.failing += 1;
    else h.verifying += 1;
    const tier = t.level >= 3 ? 'L3' : t.level === 2 ? 'L2' : 'L1';
    if (tier === 'L3') h.testedAtL3 += 1;
    else if (tier === 'L2') h.testedAtL2 += 1;
    else h.testedAtL1 += 1;
    if (t.status === 'passing') {
      if (tier === 'L3') h.passingAtL3 += 1;
      else if (tier === 'L2') h.passingAtL2 += 1;
      else h.passingAtL1 += 1;
    }
  }
  return h;
}

// ---- the app-level guard against a leak

/** Only incidents a person confirmed are ever shown, whatever the database sent. */
export const confirmedOnly = (rows: readonly PublicIncidentRow[]): PublicIncidentRow[] =>
  rows.filter((r) => r.review === 'CONFIRMED');

export interface SafeRun extends PublicRunRow {
  /** false: the failure's class, signature, failed step and every step's output have been removed. */
  causeVisible: boolean;
}

const ABOUT_US: readonly string[] = ['CRAWL_ERROR', 'COMPILER_ERROR'];

/**
 * Removes the cause of a vendor failure unless a person has confirmed an incident for the same tool AND the
 * database says the run's details are published. A run that did not fail, and one that never reached the
 * executor (it is about us, not the vendor), are shown as they are.
 */
export function sanitizeRun(run: PublicRunRow, confirmed: readonly PublicIncidentRow[]): SafeRun {
  const aboutUs = run.failure_class !== null && ABOUT_US.includes(run.failure_class);
  const publishable =
    run.outcome !== 'FAIL' ||
    aboutUs ||
    (run.details_published &&
      confirmed.some((i) => i.tool_slug === run.tool_slug && i.review === 'CONFIRMED'));
  if (publishable) return { ...run, causeVisible: true };
  return {
    ...run,
    causeVisible: false,
    failure_class: null,
    failure_signature: null,
    failed_step_id: null,
    steps: run.steps.map((s) => ({
      ...s,
      exit_code: null,
      stdout_tail: null,
      stderr_tail: null,
      log_path: null,
    })),
  };
}
