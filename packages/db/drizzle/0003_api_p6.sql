-- P6 (spec sections 5 and 11). Never edit this file once applied.
--  * compiled_plans: config_hash (hash of placeholders, level, language, extract.variants) joins the cache
--    key, and `truncation` stores what the model did not see of a long page (P5 carry-forward).
--  * probe_cycles: gh_run_attempt (+ unique index with gh_run_id: POST /internal/cycles is idempotent) and
--    finish_result (POST /internal/cycles/:id/finish returns it unchanged when repeated).
--  * tools.is_canary (generated): canaries are harness probes. They stay out of the status engine and of
--    the public views, recreated at the end of this file.
--  * incidents.version_diff: the runner_env.resolved diff written by incident enrichment.
--  * admin_queue_items: GET /admin/queue (RLS on, no anon access).
--  * indexes: llm_calls(created_at) for the token-budget query, submissions(ip_hash, created_at) for 5/day.

CREATE TABLE "admin_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reason" text NOT NULL,
	"tool_id" uuid,
	"run_id" uuid,
	"cycle_id" uuid,
	"incident_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "admin_queue_items_state_check" CHECK ("admin_queue_items"."state" in ('OPEN','DONE'))
);
--> statement-breakpoint
ALTER TABLE "compiled_plans" DROP CONSTRAINT "compiled_plans_tool_id_content_hash_compiler_version_key";--> statement-breakpoint
ALTER TABLE "compiled_plans" ADD COLUMN "config_hash" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "compiled_plans" ALTER COLUMN "config_hash" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "compiled_plans" ADD COLUMN "truncation" jsonb DEFAULT '{"truncated":false,"totalBlocks":0,"includedBlocks":0,"omittedBlocks":0,"omittedBlockIndexes":[],"clippedBlockIndexes":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "compiled_plans" ALTER COLUMN "truncation" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "version_diff" jsonb;--> statement-breakpoint
ALTER TABLE "probe_cycles" ADD COLUMN "gh_run_attempt" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "probe_cycles" ADD COLUMN "finish_result" jsonb;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "is_canary" boolean GENERATED ALWAYS AS (slug LIKE 'canary-%') STORED;--> statement-breakpoint
ALTER TABLE "admin_queue_items" ADD CONSTRAINT "admin_queue_items_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_queue_items" ADD CONSTRAINT "admin_queue_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_queue_items" ADD CONSTRAINT "admin_queue_items_cycle_id_probe_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."probe_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_queue_items" ADD CONSTRAINT "admin_queue_items_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_queue_items_state_created_at_idx" ON "admin_queue_items" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_queue_items_run_reason_key" ON "admin_queue_items" USING btree ("run_id","reason") WHERE "admin_queue_items"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "llm_calls_created_at_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "probe_cycles_gh_run_key" ON "probe_cycles" USING btree ("gh_run_id","gh_run_attempt") WHERE "probe_cycles"."gh_run_id" is not null;--> statement-breakpoint
CREATE INDEX "submissions_ip_hash_created_at_idx" ON "submissions" USING btree ("ip_hash","created_at");--> statement-breakpoint
ALTER TABLE "compiled_plans" ADD CONSTRAINT "compiled_plans_tool_content_config_version_key" UNIQUE("tool_id","content_hash","config_hash","compiler_version");--> statement-breakpoint
ALTER TABLE "admin_queue_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "admin_queue_items" FROM anon, authenticated;--> statement-breakpoint

-- Public views again, now without canaries.
DROP VIEW "public_tools";--> statement-breakpoint
DROP VIEW "public_runs";--> statement-breakpoint
DROP VIEW "public_incidents";--> statement-breakpoint
CREATE VIEW "public_tools" AS
WITH final_runs AS (
  SELECT DISTINCT ON (r.cycle_id, r.tool_id) r.tool_id, r.outcome, r.started_at
  FROM runs r
  JOIN probe_cycles c ON c.id = r.cycle_id
  WHERE c.valid IS TRUE
  ORDER BY r.cycle_id, r.tool_id, r.attempt DESC
),
stats AS (
  SELECT tool_id,
         count(*) FILTER (WHERE outcome = 'PASS') AS passes,
         count(*) FILTER (WHERE outcome IN ('PASS', 'FAIL')) AS decided
  FROM final_runs
  WHERE started_at >= now() - interval '30 days'
  GROUP BY tool_id
)
SELECT t.slug,
       t.name,
       t.docs_url,
       t.language,
       t.level,
       CASE
         WHEN t.status = 'BROKEN' AND NOT EXISTS (
           SELECT 1 FROM incidents i
           WHERE i.tool_id = t.id AND i.state = 'OPEN' AND i.review = 'CONFIRMED'
         ) THEN 'DEGRADED'::tool_status
         ELSE t.status
       END AS status,
       t.status_since,
       t.last_run_at,
       CASE WHEN s.decided > 0 THEN round(s.passes::numeric / s.decided, 4) END AS pass_rate_30d,
       CASE WHEN t.consecutive_failures > 0 THEN t.consecutive_failures ELSE t.consecutive_passes END AS current_streak,
       CASE WHEN t.consecutive_failures > 0 THEN 'fail' ELSE 'pass' END AS streak_kind
FROM tools t
LEFT JOIN stats s ON s.tool_id = t.id
WHERE t.enabled AND NOT t.is_canary;--> statement-breakpoint
CREATE VIEW "public_runs" AS
SELECT r.id,
       t.slug AS tool_slug,
       r.cycle_id,
       r.attempt,
       r.outcome,
       r.failure_class,
       r.failure_signature,
       r.failed_step_id,
       r.image_digest,
       r.runner_env,
       r.duration_ms,
       r.started_at,
       r.finished_at,
       ds.content_hash AS snapshot_hash,
       cp.ir AS plan_ir,
       cp.grounding_report,
       COALESCE((
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'step_id', s.step_id,
                    'ordinal', s.ordinal,
                    'kind', s.kind,
                    'outcome', s.outcome,
                    'exit_code', s.exit_code,
                    'duration_ms', s.duration_ms,
                    'stdout_tail', s.stdout_tail,
                    'stderr_tail', s.stderr_tail,
                    'log_path', s.log_path
                  ) ORDER BY s.ordinal)
         FROM step_results s
         WHERE s.run_id = r.id
       ), '[]'::jsonb) AS steps
FROM runs r
JOIN tools t ON t.id = r.tool_id AND t.enabled AND NOT t.is_canary
JOIN probe_cycles c ON c.id = r.cycle_id AND c.valid IS TRUE
LEFT JOIN doc_snapshots ds ON ds.id = r.snapshot_id
LEFT JOIN compiled_plans cp ON cp.id = r.plan_id
WHERE r.started_at >= now() - interval '90 days';--> statement-breakpoint
CREATE VIEW "public_incidents" AS
SELECT i.id,
       t.slug AS tool_slug,
       t.name AS tool_name,
       i.signature,
       i.failure_class,
       i.state,
       i.review,
       i.first_failing_run_id,
       i.last_passing_run_id,
       i.docs_changed,
       i.docs_diff_path,
       i.summary,
       i.suggested_fix,
       i.opened_at,
       i.confirmed_at,
       i.resolved_at,
       COALESCE((
         SELECT jsonb_agg(
                  jsonb_build_object('type', e.type, 'payload', e.payload, 'at', e.at)
                  ORDER BY e.at, e.id)
         FROM incident_events e
         WHERE e.incident_id = i.id AND e.type <> 'note'
       ), '[]'::jsonb) AS events
FROM incidents i
JOIN tools t ON t.id = i.tool_id AND t.enabled AND NOT t.is_canary
WHERE i.review = 'CONFIRMED';--> statement-breakpoint
GRANT SELECT ON "public_tools", "public_runs", "public_incidents" TO anon, authenticated;--> statement-breakpoint

NOTIFY pgrst, 'reload schema';
