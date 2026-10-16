import { z } from 'zod';
import { PreflightFailure } from './api.js';
import { StepIR } from './step-ir.js';
import { Target } from './target.js';

// Spec section 12: the files the probe pipeline passes between its three jobs.
//   plans/<slug>.json   one per tool, written by `qsr plan`
//   plans/manifest.json the cycle, its shard count and every tool's state
// `qsr execute` (a job with no secrets, on another machine) and `qsr report` parse them with these schemas;
// an artifact is data from another job and is never trusted unparsed.

export const PROBE_FILE_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';

/** Why a tool has no plan to run (informational, nothing is posted for it). */
export const DEFERRAL_REASONS = ['llm_budget', 'llm_unavailable', 'llm_timeout'] as const;
export const DeferralReason = z.enum(DEFERRAL_REASONS);
export type DeferralReason = z.infer<typeof DeferralReason>;

const common = {
  version: z.literal(PROBE_FILE_VERSION),
  toolSlug: z.string().min(1).max(64),
  cycleId: z.uuid(),
  isCanary: z.boolean(),
  target: Target,
  /** The tool's last duration (from the cycles response), used to order shards heaviest first. */
  weightMs: z.number().int().min(0).nullable(),
};

/** A plan the executor will run. */
export const ReadyPlan = z.object({
  /** null for a canary: its golden plan is committed in the repo, never compiled. */
  planId: z.uuid().nullable(),
  snapshotHash: z.string().nullable(),
  ir: StepIR,
  /** true when the model was not asked (token budget) and the tool's last accepted plan is used. */
  stale: z.boolean(),
  compilerVersion: z.string().nullable(),
});
export type ReadyPlan = z.infer<typeof ReadyPlan>;

export const PlanFile = z.discriminatedUnion('state', [
  z.object({
    ...common,
    state: z.literal('ready'),
    shard: z.number().int().min(0),
    plan: ReadyPlan,
  }),
  /** Crawl or compile failed: `qsr report` posts it as a run without execution. */
  z.object({
    ...common,
    state: z.literal('pre_failed'),
    preflight: PreflightFailure,
    planId: z.uuid().nullable(),
    snapshotHash: z.string().nullable(),
  }),
  /** The model was not asked or could not answer and there is no earlier plan: an informational skip. */
  z.object({
    ...common,
    state: z.literal('deferred'),
    reason: DeferralReason,
  }),
]);
export type PlanFile = z.infer<typeof PlanFile>;

export const ManifestTool = z.object({
  toolSlug: z.string(),
  state: z.enum(['ready', 'pre_failed', 'deferred']),
  shard: z.number().int().min(0).nullable(),
  stale: z.boolean(),
  isCanary: z.boolean(),
});
export type ManifestTool = z.infer<typeof ManifestTool>;

export const Manifest = z
  .object({
    version: z.literal(PROBE_FILE_VERSION),
    cycleId: z.uuid(),
    createdAt: z.iso.datetime(),
    shards: z.number().int().min(1).max(20),
    /** Shards other than 0 that also run the guard canary, as a check on their own runner. */
    guards: z.array(z.number().int().min(1)).default([]),
    tools: z.array(ManifestTool),
  })
  .refine((m) => m.tools.every((t) => t.shard === null || t.shard < m.shards), {
    message: 'a tool is assigned to a shard that does not exist',
  })
  .refine((m) => m.guards.every((g) => g < m.shards), {
    message: 'a guard is assigned to a shard that does not exist',
  });
export type Manifest = z.infer<typeof Manifest>;
