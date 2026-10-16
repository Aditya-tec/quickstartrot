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
    status: toolStatus('status').notNull().default('UNKNOWN'),
    statusSince: tstz('status_since'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutivePasses: integer('consecutive_passes').notNull().default(0),
    lastRunAt: tstz('last_run_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
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
    compilerVersion: text('compiler_version').notNull(), // bump to invalidate cache
    model: text('model').notNull(),
    ir: jsonb('ir'), // Step IR, null if rejected
    groundingReport: jsonb('grounding_report').notNull(),
    accepted: boolean('accepted').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('compiled_plans_tool_id_content_hash_compiler_version_key').on(
      t.toolId,
      t.contentHash,
      t.compilerVersion,
    ),
  ],
);

export const probeCycles = pgTable('probe_cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  trigger: text('trigger').notNull(), // cron | manual | target_pr
  gitSha: text('git_sha').notNull(),
  ghRunId: bigint('gh_run_id', { mode: 'number' }),
  canaryOk: boolean('canary_ok'), // null until canaries report
  valid: boolean('valid'), // false => runs ignored by status engine
  startedAt: tstz('started_at').notNull().defaultNow(),
  finishedAt: tstz('finished_at'),
});

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

export const submissions = pgTable('submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  docsUrl: text('docs_url').notNull(),
  contact: text('contact'),
  note: text('note'),
  ipHash: text('ip_hash').notNull(),
  status: text('status').notNull().default('NEW'), // NEW | ACCEPTED | REJECTED
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const llmCalls = pgTable('llm_calls', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  purpose: text('purpose').notNull(), // compile | classify | summarize
  model: text('model').notNull(),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  latencyMs: integer('latency_ms').notNull(),
  ok: boolean('ok').notNull(),
  error: text('error'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

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
] as const;

/** The only relations the anon role may select (spec section 5, public read path). */
export const PUBLIC_VIEWS = ['public_tools', 'public_runs', 'public_incidents'] as const;
