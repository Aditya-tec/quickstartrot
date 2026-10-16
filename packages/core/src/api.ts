import { z } from 'zod';
import { Extraction } from './extraction.js';
import { RunResult } from './run-result.js';
import { GroundingReport, StepIR } from './step-ir.js';
import { StatusEvent } from './status.js';
import { Target } from './target.js';
import { FailureClass, Language, ReviewState, ToolStatus } from './taxonomy.js';
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
export const GcResponse = z.object({
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
