import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  FAILURE_CLASSES,
  INCIDENT_STATES,
  REVIEW_STATES,
  RUN_OUTCOMES,
  TOOL_STATUSES,
} from '@qsr/core';

// Spec section 5. Written only by apps/api; every run is immutable, status and incidents are
// derived state. All timestamps are timestamptz (UTC).

export const toolStatus = pgEnum('tool_status', TOOL_STATUSES);
export const runOutcome = pgEnum('run_outcome', RUN_OUTCOMES);
export const failureClass = pgEnum('failure_class', FAILURE_CLASSES);
export const incidentState = pgEnum('incident_state', INCIDENT_STATES);
export const reviewState = pgEnum('review_state', REVIEW_STATES);

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const tools = pgTable(
  'tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(), // matches targets/<slug>.yaml
    name: text('name').notNull(),
    docsUrl: text('docs_url').notNull(),
    language: text('language').notNull(),
    level: smallint('level').notNull(),
    config: jsonb('config').notNull(), // full parsed YAML
    configHash: text('config_hash').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // Why a tool is off: its target file was removed (a re-sync may bring it back) or an admin paused it
    // (a re-sync must NOT re-enable it) or the vendor opted out ('opt_out', see opted_out_at; same rule). Null while enabled.
    disabledReason: text('disabled_reason'),
    // A vendor asked us to stop (disabled_reason = 'opt_out'): when we stopped. The tool's page stays up, labelled as no longer
    // monitored at the vendor's request; its past results stay visible unless the vendor also asked for them to be hidden.
    optedOutAt: tstz('opted_out_at'),
    historyHidden: boolean('history_hidden').notNull().default(false),
    status: toolStatus('status').notNull().default('UNKNOWN'),
    statusSince: tstz('status_since'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutivePasses: integer('consecutive_passes').notNull().default(0),
    // Status engine state (packages/status, spec section 10): see ToolState in @qsr/core.
    transientStreak: integer('transient_streak').notNull().default(0),
    lastFailureSignature: text('last_failure_signature'),
    lastFailureClass: failureClass('last_failure_class'),
    // The harness version the last counted failure ran under: failures under different versions are never consecutive
    // (P9d, packages/status). Null while there is no counted failure.
    lastFailureHarnessVersion: smallint('last_failure_harness_version'),
    lastRunAt: tstz('last_run_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    // Canaries (targets/_canary) are harness probes, not tracked tools: never in the status engine or the public views.
    isCanary: boolean('is_canary').generatedAlwaysAs(sql`slug LIKE 'canary-%'`),
  },
  (t) => [
    check('tools_language_check', sql`${t.language} in ('node','python')`),
    check('tools_level_check', sql`${t.level} between 1 and 4`),
  ],
);

export const docSnapshots = pgTable(
  'doc_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id),
    contentHash: text('content_hash').notNull(), // sha256 of normalized extraction
    extraction: jsonb('extraction').notNull(), // blocks, headings, tab labels
    storagePath: text('storage_path'), // gzipped raw HTML
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [unique('doc_snapshots_tool_id_content_hash_key').on(t.toolId, t.contentHash)],
);

export const compiledPlans = pgTable(
  'compiled_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id),
    contentHash: text('content_hash').notNull(),
    // Hash of the compile-relevant target fields (placeholders, level, language, extract.variants).
    configHash: text('config_hash').notNull(),
    compilerVersion: text('compiler_version').notNull(), // bump to invalidate cache
    model: text('model').notNull(),
    ir: jsonb('ir'), // Step IR, null if rejected
    groundingReport: jsonb('grounding_report').notNull(),
    accepted: boolean('accepted').notNull(),
    // What the model did not see of a long page (P5): a plan from part of a page must never look complete.
    truncation: jsonb('truncation').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('compiled_plans_tool_content_config_version_key').on(
      t.toolId,
      t.contentHash,
      t.configHash,
      t.compilerVersion,
    ),
  ],
);

export const probeCycles = pgTable(
  'probe_cycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trigger: text('trigger').notNull(), // cron | manual | target_pr
    gitSha: text('git_sha').notNull(),
    ghRunId: bigint('gh_run_id', { mode: 'number' }),
    // With gh_run_id this makes cycle creation idempotent: a retried plan job must not create a second cycle.
    ghRunAttempt: smallint('gh_run_attempt').notNull().default(1),
    canaryOk: boolean('canary_ok'), // null until canaries report
    valid: boolean('valid'), // false => runs ignored by status engine
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    // The stored outcome of POST /internal/cycles/:id/finish, returned unchanged on a repeat call.
    finishResult: jsonb('finish_result'),
  },
  (t) => [
    uniqueIndex('probe_cycles_gh_run_key')
      .on(t.ghRunId, t.ghRunAttempt)
      .where(sql`${t.ghRunId} is not null`),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => probeCycles.id),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id),
    planId: uuid('plan_id').references(() => compiledPlans.id),
    snapshotId: uuid('snapshot_id').references(() => docSnapshots.id),
    attempt: smallint('attempt').notNull().default(1),
    outcome: runOutcome('outcome').notNull(),
    failureClass: failureClass('failure_class'),
    failureSignature: text('failure_signature'), // sha256 of normalized error
    failedStepId: text('failed_step_id'),
    classifierRule: text('classifier_rule'), // rule id or 'llm'
    // The status engine reads both (spec section 10): the level reached, and why a run was skipped.
    reachedLevel: smallint('reached_level').notNull().default(0),
    skipReason: text('skip_reason'), // 'manual_step' or null
    // Which version of the harness checks produced this run (P9d). Everything recorded before it is version 1.
    harnessVersion: smallint('harness_version').notNull().default(1),
    imageDigest: text('image_digest').notNull(),
    runnerEnv: jsonb('runner_env').notNull(), // node/python version, runner os, region
    durationMs: integer('duration_ms').notNull(),
    startedAt: tstz('started_at').notNull(),
    finishedAt: tstz('finished_at').notNull(),
  },
  (t) => [
    unique('runs_cycle_id_tool_id_attempt_key').on(t.cycleId, t.toolId, t.attempt), // idempotent ingest
    index('runs_tool_id_started_at_idx').on(t.toolId, t.startedAt.desc()),
    index('runs_cycle_id_idx').on(t.cycleId),
  ],
);

export const stepResults = pgTable(
  'step_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    ordinal: smallint('ordinal').notNull(),
    kind: text('kind').notNull(),
    outcome: text('outcome').notNull(), // PASS | FAIL | SKIPPED
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms').notNull(),
    stdoutTail: text('stdout_tail'), // last 4 KB, redacted
    stderrTail: text('stderr_tail'),
    logPath: text('log_path'), // full redacted log in storage
    harnessVersion: smallint('harness_version').notNull().default(1),
    // Shadow mode (P9d): the experimental export check's result, kept on the L2 imports-check step it follows. It is NEVER
    // read by the status engine, the classifier or the public views.
    shadowExportCheck: jsonb('shadow_export_check'),
    // Shadow-L3: what the L3 step of a shadow target said (verdict, pattern, observed text). Recorded, never read into a verdict.
    shadowL3: jsonb('shadow_l3'),
  },
  (t) => [index('step_results_run_id_ordinal_idx').on(t.runId, t.ordinal)],
);

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id),
    signature: text('signature').notNull(),
    failureClass: failureClass('failure_class').notNull(),
    state: incidentState('state').notNull().default('OPEN'),
    review: reviewState('review').notNull().default('PENDING_REVIEW'),
    firstFailingRunId: uuid('first_failing_run_id').references(() => runs.id),
    lastPassingRunId: uuid('last_passing_run_id').references(() => runs.id),
    docsChanged: boolean('docs_changed'), // content hash differs between the two runs
    docsDiffPath: text('docs_diff_path'),
    versionDiff: jsonb('version_diff'), // runner_env.resolved: last passing run vs first failing run
    summary: text('summary'), // LLM draft, edited by reviewer
    suggestedFix: text('suggested_fix'),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    confirmedAt: tstz('confirmed_at'),
    resolvedAt: tstz('resolved_at'),
  },
  (t) => [
    uniqueIndex('one_open_incident_per_tool')
      .on(t.toolId)
      .where(sql`${t.state} = 'OPEN'`),
  ],
);

export const incidentEvents = pgTable('incident_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  incidentId: uuid('incident_id')
    .notNull()
    .references(() => incidents.id),
  type: text('type').notNull(), // opened | confirmed | false_positive | recurred | resolved | note
  payload: jsonb('payload')
    .notNull()
    .default(sql`'{}'::jsonb`),
  at: tstz('at').notNull().defaultNow(),
});

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docsUrl: text('docs_url').notNull(),
    contact: text('contact'),
    note: text('note'),
    ipHash: text('ip_hash').notNull(),
    status: text('status').notNull().default('NEW'), // NEW | ACCEPTED | REJECTED
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('submissions_ip_hash_created_at_idx').on(t.ipHash, t.createdAt)],
);

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    purpose: text('purpose').notNull(), // compile | classify | summarize
    model: text('model').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    latencyMs: integer('latency_ms').notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('llm_calls_created_at_idx').on(t.createdAt)],
);

/**
 * Things for a person to look at (spec section 11, GET /admin/queue): UNKNOWN and LLM-made classifications,
 * crawl/compile/config errors, deferred compiles, enrichment failures. Never an incident, never public.
 */
export const adminQueueItems = pgTable(
  'admin_queue_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reason: text('reason').notNull(), // AdminQueueReason, or compile_deferred | enrichment_failed | llm_classified
    toolId: uuid('tool_id').references(() => tools.id),
    runId: uuid('run_id').references(() => runs.id),
    cycleId: uuid('cycle_id').references(() => probeCycles.id),
    incidentId: uuid('incident_id').references(() => incidents.id),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    state: text('state').notNull().default('OPEN'), // OPEN | DONE
    createdAt: tstz('created_at').notNull().defaultNow(),
    resolvedAt: tstz('resolved_at'),
  },
  (t) => [
    check('admin_queue_items_state_check', sql`${t.state} in ('OPEN','DONE')`),
    index('admin_queue_items_state_created_at_idx').on(t.state, t.createdAt),
    // One item per (run, reason): ingest and cycle finish can both be retried.
    uniqueIndex('admin_queue_items_run_reason_key')
      .on(t.runId, t.reason)
      .where(sql`${t.runId} is not null`),
  ],
);

/** Every base table, for RLS enforcement and tests. */
export const BASE_TABLES = [
  'tools',
  'doc_snapshots',
  'compiled_plans',
  'probe_cycles',
  'runs',
  'step_results',
  'incidents',
  'incident_events',
  'submissions',
  'llm_calls',
  'admin_queue_items',
] as const;

/** The only relations the anon role may select (spec section 5, public read path). */
export const PUBLIC_VIEWS = [
  'public_tools',
  'public_runs',
  'public_incidents',
  'public_run_history',
] as const;
