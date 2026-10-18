import { z } from 'zod';
import { Extraction } from './extraction.js';
import { RunResult } from './run-result.js';
import { GroundingReport, StepIR } from './step-ir.js';
import { StatusEvent } from './status.js';
import { Target } from './target.js';
import { FailureClass, IncidentState, Language, ReviewState, ToolStatus } from './taxonomy.js';
import { Truncation } from './extraction.js';

// Spec section 11: the API's bodies and responses, shared by apps/api and the CLI client so neither side
// can drift. Every boundary is parsed with these.

const Uuid = z.uuid();

export const Health = z.object({
  status: z.literal('ok'),
  db: z.literal(true),
  time: z.iso.datetime(),
});

// ---- POST /submissions
export const SubmissionBody = z.object({
  docsUrl: z.string().min(1).max(2048),
  contact: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
  turnstileToken: z.string().max(4096).optional(),
});
export type SubmissionBody = z.infer<typeof SubmissionBody>;
export const SubmissionResponse = z.object({ id: Uuid, status: z.literal('NEW') });

// ---- POST /internal/targets/sync
export const SyncBody = z.object({ targets: z.array(Target).max(500) });
export type SyncBody = z.infer<typeof SyncBody>;
export const SyncResponse = z.object({
  created: z.array(z.string()),
  updated: z.array(z.string()),
  unchanged: z.array(z.string()),
  /** Tools whose file was removed. */
  disabled: z.array(z.string()),
  /** Tools an admin paused: a re-sync leaves them off. */
  keptDisabled: z.array(z.string()),
  /** Targets marked enabled: false that have no tool yet: nothing was created for them. */
  skipped: z.array(z.string()).default([]),
});

// ---- POST /internal/cycles
export const CycleBody = z.object({
  trigger: z.enum(['cron', 'manual', 'target_pr']),
  gitSha: z.string().min(7).max(64),
  /** GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT: together they make cycle creation idempotent. */
  ghRunId: z.number().int().positive().optional(),
  ghRunAttempt: z.number().int().min(1).max(1000).default(1),
});
export type CycleBody = z.infer<typeof CycleBody>;
export const CycleTool = z.object({
  slug: z.string(),
  name: z.string(),
  docsUrl: z.string(),
  language: Language,
  level: z.number().int(),
  isCanary: z.boolean(),
  /** Duration of the tool's last final run, so the plan job can shard heaviest first. */
  lastDurationMs: z.number().int().min(0).nullable().default(null),
});
export const CycleResponse = z.object({
  cycleId: Uuid,
  /** false when this (gh_run_id, attempt) already had a cycle: a retried plan job. */
  created: z.boolean(),
  tools: z.array(CycleTool),
});
export type CycleResponse = z.infer<typeof CycleResponse>;

// ---- POST /internal/compile
export const CrawlFailure = z.object({
  reason: z.string().max(100),
  message: z.string().max(2000),
});
export const CompileBody = z.object({
  cycleId: Uuid,
  toolSlug: z.string(),
  /** Exactly one of these: the crawled page, or why crawling failed. */
  extraction: Extraction.optional(),
  crawlError: CrawlFailure.optional(),
  /**
   * false when the plan job has run out of time (its compile phase is capped): the cache and the tool's last
   * accepted plan are still served, but the model is not asked. A miss is then deferred as llm_timeout.
   */
  modelAllowed: z.boolean().default(true),
});
export type CompileBody = z.infer<typeof CompileBody>;

export const PlanPayload = z.object({
  id: Uuid,
  contentHash: z.string(),
  configHash: z.string(),
  compilerVersion: z.string(),
  model: z.string(),
  accepted: z.boolean(),
  ir: StepIR.nullable(),
  groundingReport: GroundingReport,
  truncation: Truncation,
  createdAt: z.iso.datetime(),
});
export type PlanPayload = z.infer<typeof PlanPayload>;

export const CompileResponse = z.discriminatedUnion('status', [
  /** A plan that passed the grounding validator (cached or fresh). */
  z.object({
    status: z.literal('ok'),
    fromCache: z.boolean(),
    stale: z.literal(false),
    snapshotId: Uuid,
    plan: PlanPayload,
  }),
  /** Rejected twice: COMPILER_ERROR. Ours, never the vendor's; it never touches a status. */
  z.object({
    status: z.literal('compiler_error'),
    failureClass: z.literal('COMPILER_ERROR'),
    snapshotId: Uuid,
    plan: PlanPayload,
  }),
  /** The crawl failed: CRAWL_ERROR, recorded for the admin queue. */
  z.object({ status: z.literal('crawl_error'), failureClass: z.literal('CRAWL_ERROR') }),
  /**
   * The model was not asked (token budget) or could not answer (429/5xx/timeout). NOT a COMPILER_ERROR and
   * never an input to a status. `plan` is the tool's most recent accepted plan, marked stale, if any.
   */
  z.object({
    status: z.literal('deferred'),
    reason: z.enum(['llm_budget', 'llm_unavailable', 'llm_timeout']),
    snapshotId: Uuid,
    stale: z.boolean(),
    plan: PlanPayload.nullable(),
    /** What the provider asked us to wait (Retry-After, seconds); null when it did not say. */
    retryAfterSeconds: z.number().int().min(0).nullable().default(null),
  }),
]);
export type CompileResponse = z.infer<typeof CompileResponse>;

// ---- POST /internal/uploads
export const UploadsBody = z.object({
  cycleId: Uuid,
  toolSlug: z.string(),
  attempt: z.number().int().min(1).max(20),
  files: z
    .array(
      z.object({ stepId: z.string().min(1).max(64), ordinal: z.number().int().min(0).max(255) }),
    )
    .min(1)
    .max(64),
});
export type UploadsBody = z.infer<typeof UploadsBody>;
export const UploadsResponse = z.object({
  bucket: z.string(),
  files: z.array(
    z.object({
      stepId: z.string(),
      /** Storage path; send it back in POST /internal/runs `logPaths`. */
      path: z.string(),
      /** PUT the gzipped log here. */
      signedUrl: z.string(),
      token: z.string(),
    }),
  ),
});
export type UploadsResponse = z.infer<typeof UploadsResponse>;

// ---- POST /internal/runs
/**
 * A run that never reached the executor: the crawl or the compile failed (spec section 10: CRAWL_ERROR and
 * COMPILER_ERROR never change a status and never open an incident; they are listed for a person). Sent
 * beside a synthetic RunResult (outcome FAIL, no steps), which keeps the RunResult contract unchanged.
 */
export const PreflightFailure = z.object({
  stage: z.enum(['crawl', 'compile']),
  failureClass: z.enum(['CRAWL_ERROR', 'COMPILER_ERROR']),
  reason: z.string().min(1).max(100),
  message: z.string().max(2000),
});
export type PreflightFailure = z.infer<typeof PreflightFailure>;
export const RunBody = z.object({
  runResult: RunResult,
  /** stepId -> storage path returned by /internal/uploads. */
  logPaths: z.record(z.string(), z.string()).default({}),
  preflight: PreflightFailure.optional(),
});
export type RunBody = z.infer<typeof RunBody>;
export const ClassificationPayload = z.object({
  failureClass: FailureClass,
  ruleId: z.string(),
  signature: z.string(),
  evidenceLine: z.string().nullable(),
  source: z.enum(['rule', 'llm', 'none']),
});
export const RunResponse = z.object({
  runId: Uuid,
  /** false when (cycleId, toolSlug, attempt) was already ingested. */
  created: z.boolean(),
  classification: ClassificationPayload.nullable(),
});
export type RunResponse = z.infer<typeof RunResponse>;

// ---- POST /internal/cycles/:id/finish
export const FinishResponse = z.object({
  cycleId: Uuid,
  valid: z.boolean(),
  canaryOk: z.boolean(),
  canaryProblems: z.array(z.string()),
  /** One entry per tool that had a run in the cycle (canaries excluded). Empty when the cycle is invalid. */
  tools: z.array(
    z.object({
      slug: z.string(),
      before: ToolStatus,
      after: ToolStatus,
      events: z.array(StatusEvent),
    }),
  ),
  /** Set when the cycle was invalid: the single cycle_ignored note. */
  ignored: z.string().nullable(),
  finishedAt: z.iso.datetime(),
});
export type FinishResponse = z.infer<typeof FinishResponse>;

// ---- /admin/*
export const ConfirmBody = z.object({
  summary: z.string().min(1).max(4000),
  suggestedFix: z.string().max(4000).default(''),
});
export const FalsePositiveBody = z.object({ reason: z.string().min(1).max(2000) });
export const AdminQueueResponse = z.object({
  pendingIncidents: z.array(
    z.object({
      id: Uuid,
      toolSlug: z.string(),
      signature: z.string(),
      failureClass: FailureClass,
      review: ReviewState,
      openedAt: z.iso.datetime(),
      summary: z.string().nullable(),
      suggestedFix: z.string().nullable(),
      docsChanged: z.boolean().nullable(),
    }),
  ),
  items: z.array(
    z.object({
      id: Uuid,
      reason: z.string(),
      toolSlug: z.string().nullable(),
      runId: Uuid.nullable(),
      cycleId: Uuid.nullable(),
      detail: z.unknown(),
      createdAt: z.iso.datetime(),
    }),
  ),
  submissions: z.array(
    z.object({
      id: Uuid,
      docsUrl: z.string(),
      contact: z.string().nullable(),
      note: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type AdminQueueResponse = z.infer<typeof AdminQueueResponse>;
// ---- GET /admin/stats?days=N (P9a): everything the calibration review reads, in one answer
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Rate = z.number().min(0).max(1);
export const StatsResponse = z.object({
  generatedAt: z.iso.datetime(),
  days: z.number().int(),
  since: z.iso.datetime(),
  cycles: z.object({
    total: z.number().int(),
    valid: z.number().int(),
    invalid: z.number().int(),
    unfinished: z.number().int(),
    /** Newest first, at most 50. */
    recent: z.array(
      z.object({
        id: Uuid,
        startedAt: z.iso.datetime(),
        trigger: z.string(),
        valid: z.boolean().nullable(),
        canaryOk: z.boolean().nullable(),
        durationSeconds: z.number().nullable(),
        tools: z.number().int(),
        harnessErrors: z.number().int(),
        /** Why an invalid cycle is invalid (the canary problems the finish step recorded). */
        problems: z.array(z.string()),
      }),
    ),
  }),
  /** Final attempts of real tools that ran, in every finished cycle: errors of ours, as a share. */
  harness: z.object({
    overall: z.object({ runs: z.number().int(), errors: z.number().int(), rate: Rate }),
    byDay: z.array(
      z.object({ day: Day, runs: z.number().int(), errors: z.number().int(), rate: Rate }),
    ),
    /** Which harness versions produced the runs of the window (P9d): version 1 is everything before versioning. */
    versions: z.array(
      z.object({
        version: z.number().int(),
        runs: z.number().int(),
        firstAt: z.iso.datetime(),
        lastAt: z.iso.datetime(),
      }),
    ),
  }),
  tools: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      level: z.number().int(),
      status: ToolStatus,
      pass: z.number().int(),
      fail: z.number().int(),
      skipped: z.number().int(),
      harnessErrors: z.number().int(),
      /** Runs that never executed (crawl or compile problem): not a verdict on the tool. */
      notRun: z.number().int(),
      /** Cycles in which the model was out and no plan came (admin queue items). */
      deferred: z.number().int(),
      staleRuns: z.number().int(),
      /** Pass/fail alternations over the decided runs, as a share: 0 steady, 1 flips every cycle. */
      flakeScore: Rate,
      flipping: z.boolean(),
      medianDurationMs: z.number().int().nullable(),
      maxDurationMs: z.number().int().nullable(),
    }),
  ),
  unknowns: z.array(
    z.object({
      runId: Uuid,
      slug: z.string(),
      startedAt: z.iso.datetime(),
      failedStepId: z.string().nullable(),
      evidenceLine: z.string().nullable(),
    }),
  ),
  llmClassified: z.array(
    z.object({
      runId: Uuid.nullable(),
      slug: z.string().nullable(),
      createdAt: z.iso.datetime(),
      failureClass: z.string().nullable(),
      confidence: z.number().nullable(),
      evidenceLine: z.string().nullable(),
    }),
  ),
  compile: z.object({
    deferrals: z.array(
      z.object({
        slug: z.string(),
        count: z.number().int(),
        reasons: z.record(z.string(), z.number().int()),
      }),
    ),
    staleRuns: z.number().int(),
    /** Pages whose content hash changed in the window (2 or more distinct hashes), most first. */
    hashChurn: z.object({
      flagAt: z.number().int(),
      tools: z.array(
        z.object({ slug: z.string(), distinctHashes: z.number().int(), flagged: z.boolean() }),
      ),
    }),
    llm: z.object({
      calls: z.number().int(),
      failedCalls: z.number().int(),
      tokensIn: z.number().int(),
      tokensOut: z.number().int(),
    }),
  }),
  incidents: z.object({
    open: z.number().int(),
    resolved: z.number().int(),
    confirmed: z.number().int(),
    falsePositive: z.number().int(),
    pendingReview: z.number().int(),
    list: z.array(
      z.object({
        id: Uuid,
        slug: z.string(),
        state: IncidentState,
        review: ReviewState,
        failureClass: FailureClass,
        openedAt: z.iso.datetime(),
        confirmedAt: z.iso.datetime().nullable(),
        resolvedAt: z.iso.datetime().nullable(),
        docsChanged: z.boolean().nullable(),
      }),
    ),
  }),
  canaries: z.array(
    z.object({
      slug: z.string(),
      runs: z.number().int(),
      expected: z.string(),
      matched: z.number().int(),
      mismatched: z.number().int(),
    }),
  ),
  slowest: z.array(
    z.object({
      slug: z.string(),
      medianDurationMs: z.number().int(),
      maxDurationMs: z.number().int(),
    }),
  ),
  groq: z.array(
    z.object({
      day: Day,
      calls: z.number().int(),
      failedCalls: z.number().int(),
      tokens: z.number().int(),
    }),
  ),
  storage: z.object({
    database: z.object({
      bytes: z.number().int(),
      limitBytes: z.number().int(),
      percent: z.number(),
    }),
    tables: z.array(
      z.object({ name: z.string(), rows: z.number().int(), bytes: z.number().int() }),
    ),
    /** Supabase Storage (logs, diffs, traces). Null when the database cannot see it (a plain Postgres). */
    objects: z
      .object({
        publicBytes: z.number().int(),
        privateBytes: z.number().int(),
        publicCount: z.number().int(),
        privateCount: z.number().int(),
        totalBytes: z.number().int(),
        limitBytes: z.number().int(),
        targetBytes: z.number().int(),
        percent: z.number(),
      })
      .nullable(),
  }),
});
export type StatsResponse = z.infer<typeof StatsResponse>;

// ---- GET /admin/shadow?days=N (P9d): what the export check, run in shadow mode, said. Read by `qsr shadow-report` and by nothing that
// decides a status: the answers are recorded, never acted on, and P9b uses this to decide whether to promote the check.
export const ShadowToolRow = z.object({
  slug: z.string(),
  /** The reason a target opted out of the check (target file harness.skipExportCheck), or null. */
  optOut: z.string().nullable(),
  /** Valid cycles in which the tool ran under a harness that records shadow results (version 2 or later). */
  cycles: z.number().int(),
  /** Cycles with a shadow record, and how they came out. cycles - withShadow = cycles with no record (an install-only plan, say). */
  withShadow: z.number().int(),
  pass: z.number().int(),
  fail: z.number().int(),
  skipped: z.number().int(),
  /** Names reported missing, with the number of cycles that reported each. */
  missing: z.array(z.object({ name: z.string(), cycles: z.number().int() })),
  /** Distinct notes (what could not be checked, why a check was skipped). */
  notes: z.array(z.string()),
  lastFailAt: z.iso.datetime().nullable(),
});
export type ShadowToolRow = z.infer<typeof ShadowToolRow>;
export const ShadowReportResponse = z.object({
  generatedAt: z.iso.datetime(),
  days: z.number().int(),
  since: z.iso.datetime(),
  totals: z.object({
    cycles: z.number().int(),
    runs: z.number().int(),
    withShadow: z.number().int(),
    pass: z.number().int(),
    fail: z.number().int(),
    skipped: z.number().int(),
  }),
  tools: z.array(ShadowToolRow),
  /** Every tool whose shadow check failed at least once, for a person to judge. A candidate is not a verdict. */
  falsePositiveCandidates: z.array(
    z.object({
      slug: z.string(),
      failCycles: z.number().int(),
      checkedCycles: z.number().int(),
      /** Failed in every cycle in which it was checked, with the same names: a fact about the page or the plan, not weather. */
      stable: z.boolean(),
      missing: z.array(z.string()),
      reason: z.string(),
    }),
  ),
});
export type ShadowReportResponse = z.infer<typeof ShadowReportResponse>;

// ---- GET /admin/export/launch (P9a): the numbers a launch post needs, from reviewed and confirmed material only.
// The schema admits ONLY incidents whose review is CONFIRMED: a response that carries anything else does not parse,
// so neither the API nor the CLI can publish an unreviewed failure by mistake.
export const LaunchExport = z.object({
  generatedAt: z.iso.datetime(),
  tools: z.object({
    /** Enabled tools (canaries excluded). */
    tracked: z.number().int(),
    /** By the highest level the latest run reached: L3 reached the vendor's API; L2 installed and built. */
    testedAtL3: z.number().int(),
    testedAtL2: z.number().int(),
    testedAtL1: z.number().int(),
    notYetRun: z.number().int(),
  }),
  cycles: z.object({
    valid: z.number().int(),
    invalid: z.number().int(),
    firstAt: z.iso.datetime().nullable(),
    lastAt: z.iso.datetime().nullable(),
  }),
  runs: z.object({
    /** Final attempts of real tools that ran, in valid cycles. */
    total: z.number().int(),
    perTool: z.array(
      z.object({
        slug: z.string(),
        runs: z.number().int(),
        passes: z.number().int(),
        fails: z.number().int(),
      }),
    ),
  }),
  incidents: z.object({
    confirmed: z.number().int(),
    byFailureClass: z.record(z.string(), z.number().int()),
    /** What changed between the last passing run and the first failing one, per confirmed incident. */
    coincidence: z.object({
      docsOnly: z.number().int(),
      dependencyOnly: z.number().int(),
      both: z.number().int(),
      neither: z.number().int(),
      unknown: z.number().int(),
    }),
    /** From the first failing run to the incident opening (two failures in valid cycles), and on to a person's confirmation. */
    medianHoursToDetect: z.number().nullable(),
    medianHoursToConfirm: z.number().nullable(),
    list: z.array(
      z.object({
        id: Uuid,
        slug: z.string(),
        name: z.string(),
        review: z.literal('CONFIRMED'),
        failureClass: FailureClass,
        state: IncidentState,
        openedAt: z.iso.datetime(),
        confirmedAt: z.iso.datetime().nullable(),
        resolvedAt: z.iso.datetime().nullable(),
        docsChanged: z.boolean().nullable(),
        dependencyChanged: z.boolean().nullable(),
        summary: z.string().nullable(),
        suggestedFix: z.string().nullable(),
        /** Evidence, as site paths: the tool page, the first failing run, the docs diff. */
        toolPath: z.string(),
        firstFailingRunPath: z.string().nullable(),
        docsDiffPath: z.string().nullable(),
      }),
    ),
  }),
});
export type LaunchExport = z.infer<typeof LaunchExport>;

// ---- POST /admin/plans/import (P9a): a plan compiled on a developer machine, to be checked and cached by the server
export const PlanImportBody = z.object({
  /** The target as the file says it; the server derives the config hash from it (and from the stored tool). */
  target: Target,
  /** The page the plan was compiled from. The server recomputes its content hash and re-runs the grounding validator on it. */
  extraction: Extraction,
  plan: z.object({
    contentHash: z.string().length(64),
    compilerVersion: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    ir: StepIR,
    /** Optional cross-check: must equal the config hash the server computes. */
    configHash: z.string().length(64).optional(),
  }),
});
export type PlanImportBody = z.infer<typeof PlanImportBody>;
export const PlanImportResponse = z.object({
  status: z.enum(['imported', 'already_present']),
  planId: Uuid,
  contentHash: z.string(),
  configHash: z.string(),
  compilerVersion: z.string(),
});
export type PlanImportResponse = z.infer<typeof PlanImportResponse>;

export const GcResponse = z.object({
  /** Bytes the cleanup freed, when Storage could say (the sizes of the objects it removed); null otherwise. */
  freedBytes: z.number().int().nullable().default(null),
  deletedLogs: z.number().int(),
  deletedDiffs: z.number().int(),
  deletedTraces: z.number().int(),
});

/** RFC 9457 problem details, `application/problem+json`. No stack traces, ever. */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof Problem>;

export type Health = z.infer<typeof Health>;
export type SubmissionResponse = z.infer<typeof SubmissionResponse>;
export type SyncResponse = z.infer<typeof SyncResponse>;
export type CycleTool = z.infer<typeof CycleTool>;
export type ClassificationPayload = z.infer<typeof ClassificationPayload>;
export type GcResponse = z.infer<typeof GcResponse>;
export type ConfirmBody = z.infer<typeof ConfirmBody>;
export type FalsePositiveBody = z.infer<typeof FalsePositiveBody>;
