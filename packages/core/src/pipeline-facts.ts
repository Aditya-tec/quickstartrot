import {
  FAILURES_TO_OPEN_INCIDENT,
  PASSES_TO_RECOVER,
  RECURRENCE_WINDOW_DAYS,
  TRANSIENT_INCIDENT_STREAK,
} from './status.js';

// The numbers the pipeline really uses, in one place and browser-safe (no Node built-ins). The public
// methodology page is generated from this object, so a number on the page cannot differ from the code; the
// code that enforces each one imports it from here or is pinned to it by a test:
//   cycleHours             .github/workflows/probe.yml (cron)             workflows.test.ts
//   crawlRetry*            packages/crawler (one retry, network errors)   extract.test.ts
//   transientRetry*        packages/cli probe/execute (retry once)        execute.test.ts
//   groundingRetries       packages/compiler (retry once with violations) compile.test.ts
//   failuresToOpen*, passesToRecover, transientStreak*, recurrenceWindowDays   packages/status
//   logRetentionDays, traceRetentionDays   apps/api services/gc.ts       gc.test.ts
//   canaryCount            packages/core canary.ts                         pipeline-facts.test.ts
//   optOutHours            .github/ISSUE_TEMPLATE/opt-out.yml             issue-templates test
//   disclosureWaitHours    spec section 14 (ethics): a promise, written down here so the pages quote one value

const CYCLE_HOURS = 6;

export const PIPELINE = Object.freeze({
  /** A probe cycle runs this often. */
  cycleHours: CYCLE_HOURS,
  cyclesPerDay: 24 / CYCLE_HOURS,
  /** The first failure only moves a tool to "verifying"; this many matching failures in a row open an incident. */
  failuresToOpenIncident: FAILURES_TO_OPEN_INCIDENT,
  /** Consecutive passes before a tool is healthy again (and a confirmed incident resolves). */
  passesToRecover: PASSES_TO_RECOVER,
  /** Network errors and timeouts in a row that open an incident labelled as a likely outage. */
  transientStreakToOpenIncident: TRANSIENT_INCIDENT_STREAK,
  /** A network error or timeout is retried this many times inside the cycle, after the delay below. */
  transientRetries: 1,
  transientRetryDelaySeconds: 60,
  /** A docs page that cannot be reached is retried this many times, after the delay below. */
  crawlRetries: 1,
  crawlRetryDelaySeconds: 10,
  /** A plan that fails the grounding check is retried this many times with the violations listed, then discarded. */
  groundingRetries: 1,
  /** A failure with the signature of an incident resolved within this many days reopens that incident. */
  recurrenceWindowDays: RECURRENCE_WINDOW_DAYS,
  /** Pinned to CANARY_SLUGS by pipeline-facts.test.ts (canary.ts reaches Node-only modules, so it is not imported here). */
  canaryCount: 4,
  logRetentionDays: 30,
  traceRetentionDays: 14,
  /** Ethics rules (spec section 14): an opt-out is honoured within this many hours. */
  optOutHours: 24,
  /** Before a launch post names a vendor, we tell them and wait this many hours. */
  disclosureWaitHours: 48,
});

/**
 * The Supabase free tier (spec section 2): a 500 MB Postgres and 1 GB of Storage. The nightly cleanup aims to keep
 * Storage under 800 MB (spec section 5). The admin page shows usage against these.
 */
export const FREE_TIER = Object.freeze({
  databaseBytes: 500 * 1024 * 1024,
  storageBytes: 1024 * 1024 * 1024,
  storageTargetBytes: 800 * 1024 * 1024,
});

/** What the target list aims for (docs/TARGET-SELECTION.md). An aim, not a quota that overrides the criteria. */
export const TARGET_GOAL = Object.freeze({
  total: 50,
  librariesPercent: 40,
  vendorsPercent: 60,
});
