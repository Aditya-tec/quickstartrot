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
//   optOutHours, vendorReplyBusinessDays   .github/ISSUE_TEMPLATE/opt-out.yml, docs/DISCLOSURE.md,
//                          docs/ABOUT-OUR-TRAFFIC.md, the email template   packages/cli launch-docs.test.ts, core traffic-doc.test.ts
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
  /** Network errors and timeouts in a row that open an incident labelled as a likely outage (never published). */
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
  /** A page with this many distinct content hashes in the calibration window is flagged as one that will not hold still. */
  hashChurnFlagAt: 3,
  logRetentionDays: 30,
  traceRetentionDays: 14,
  /** Ethics rules (spec section 14): probing of a vendor stops, and its history is hidden, within this many hours of an opt-out request. */
  optOutHours: 24,
  /** The owner's promise to a vendor who writes to us (2026-10-18): a written reply within this many business days. */
  vendorReplyBusinessDays: 3,
  /** Before a launch post names a vendor, we tell them and wait this many hours. */
  disclosureWaitHours: 48,
});

/**
 * What we send to the services we test (the public "About our traffic" section of /bot, and docs/ABOUT-OUR-TRAFFIC.md). For a few quickstarts
 * the check runs the docs' own code one step further, and the snippet makes ONE request with an invalid, made-up credential. The probe
 * never retries a failure at that step, so this is a ceiling, not an average. `services` is pinned to the target files by a test
 * (packages/cli committed-targets.test.ts): it lists exactly the enabled targets whose run step reaches a vendor.
 */
const REQUESTS_PER_TARGET_PER_CYCLE = 1;
export const TRAFFIC = Object.freeze({
  requestsPerTargetPerCycle: REQUESTS_PER_TARGET_PER_CYCLE,
  requestsPerTargetPerDay: PIPELINE.cyclesPerDay * REQUESTS_PER_TARGET_PER_CYCLE,
  /** When the terms of these services were last read (a summary check, not legal advice). */
  termsReviewedOn: '2026-10-18',
  /** Names only say where traffic goes; no affiliation or endorsement is implied. Sorted by name. */
  services: Object.freeze([
    Object.freeze({
      name: 'Anthropic',
      targets: Object.freeze(['anthropic-node', 'anthropic-python']),
    }),
    Object.freeze({ name: 'Cerebras', targets: Object.freeze(['cerebras-python']) }),
    Object.freeze({ name: 'OpenRouter', targets: Object.freeze(['openrouter-node']) }),
    Object.freeze({ name: 'Resend', targets: Object.freeze(['resend-node', 'resend-python']) }),
    Object.freeze({ name: 'Slack', targets: Object.freeze(['slack-node']) }),
  ]),
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

/**
 * What happens when a vendor opts out (the owner's decision of 2026-10-19). Probing stops within `PIPELINE.optOutHours`; the vendor's page stays
 * up, labelled `pageLabel`; past results stay visible and are hidden only on request. One definition: /bot, /methodology, the README block, the
 * vendor form, the disclosure policy, the traffic note, the email template and docs/CLAIMS.md all say exactly `optOutSentences()`, each
 * generated from it or pinned to it by a test. The label is what the page shows (apps/web tool page).
 */
export const OPT_OUT = Object.freeze({
  pageLabel: "No longer monitored at the vendor's request",
});

/** The three sentences. `hours` defaults to the pipeline's; a page passes its own facts so a test can prove it quotes them. */
export function optOutSentences(hours: number = PIPELINE.optOutHours): {
  probing: string;
  label: string;
  history: string;
} {
  const label = OPT_OUT.pageLabel.charAt(0).toLowerCase() + OPT_OUT.pageLabel.slice(1);
  return {
    probing: `Probing stops within ${hours} hours of an opt-out request.`,
    label: `The quickstart's page stays up, labelled "${label}".`,
    history: 'Past results stay visible and are hidden only if the vendor asks for that.',
  };
}
