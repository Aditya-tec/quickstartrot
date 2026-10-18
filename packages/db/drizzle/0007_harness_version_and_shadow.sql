-- P9d: harness versioning and the shadow export check.
--  * runs.harness_version / step_results.harness_version: which version of the harness checks produced the run. Every row recorded
--    before this migration is version 1 (the column default backfills them); the harness that ships with this change is version 2.
--  * tools.last_failure_harness_version: the status engine never counts failures under different harness versions as consecutive.
--  * step_results.shadow_export_check: the experimental export check's result (pass, fail or skipped, with the missing names), kept
--    on the L2 imports-check step. Nothing reads it but `GET /admin/shadow`: it is not in any public view.
--  * public_runs gains harness_version, as its LAST column (CREATE OR REPLACE VIEW may only append), so the run page can say which
--    harness produced a run. Grants on the view are kept by CREATE OR REPLACE.
-- Additive only: the previous API and website keep working against this schema.

ALTER TABLE "runs" ADD COLUMN "harness_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_results" ADD COLUMN "harness_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_results" ADD COLUMN "shadow_export_check" jsonb;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "last_failure_harness_version" smallint;--> statement-breakpoint
CREATE OR REPLACE VIEW "public_runs" AS
WITH windows AS (
  -- from the incident's first failing run until it resolved (open: until now and beyond)
  SELECT i.tool_id,
         COALESCE(fr.started_at, i.opened_at) AS from_at,
         COALESCE(i.resolved_at, 'infinity'::timestamptz) AS to_at
  FROM incidents i
  LEFT JOIN runs fr ON fr.id = i.first_failing_run_id
  WHERE i.review = 'CONFIRMED'
),
visible AS (
  SELECT r.*, t.slug,
         (
           r.outcome <> 'FAIL'
           OR r.failure_class IN ('CRAWL_ERROR', 'COMPILER_ERROR')
           OR EXISTS (
             SELECT 1 FROM windows w
             WHERE w.tool_id = r.tool_id AND r.started_at >= w.from_at AND r.started_at <= w.to_at
           )
         ) AS published
  FROM runs r
  JOIN tools t ON t.id = r.tool_id AND t.enabled AND NOT t.is_canary
  JOIN probe_cycles c ON c.id = r.cycle_id AND c.valid IS TRUE
  WHERE r.started_at >= now() - interval '90 days'
)
SELECT v.id,
       v.slug AS tool_slug,
       v.cycle_id,
       v.attempt,
       v.outcome,
       CASE WHEN v.published THEN v.failure_class END AS failure_class,
       CASE WHEN v.published THEN v.failure_signature END AS failure_signature,
       CASE WHEN v.published THEN v.failed_step_id END AS failed_step_id,
       v.image_digest,
       v.runner_env,
       v.duration_ms,
       v.started_at,
       v.finished_at,
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
                    'exit_code', CASE WHEN v.published THEN s.exit_code END,
                    'duration_ms', s.duration_ms,
                    'stdout_tail', CASE WHEN v.published THEN s.stdout_tail END,
                    'stderr_tail', CASE WHEN v.published THEN s.stderr_tail END,
                    'log_path', CASE WHEN v.published THEN s.log_path END
                  ) ORDER BY s.ordinal)
         FROM step_results s
         WHERE s.run_id = v.id
       ), '[]'::jsonb) AS steps,
       v.published AS details_published,
       v.reached_level,
       v.skip_reason,
       cp.compiler_version AS plan_compiler_version,
       cp.truncation AS plan_truncation,
       COALESCE(v.runner_env ->> 'plan_stale' = 'true', false) AS plan_stale,
       ds.extraction -> 'blocks' AS snapshot_blocks,
       ds.extraction ->> 'title' AS snapshot_title,
       ds.extraction ->> 'url' AS snapshot_url,
       v.harness_version
FROM visible v
LEFT JOIN doc_snapshots ds ON ds.id = v.snapshot_id
LEFT JOIN compiled_plans cp ON cp.id = v.plan_id;--> statement-breakpoint

NOTIFY pgrst, 'reload schema';
