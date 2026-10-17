-- P8 (spec sections 5 and 13). Never edit this file once applied. Only views change; no table, no data.
--
-- The rule behind all of it: an unreviewed failure shows "verifying" and NO cause text. That has to hold in the
-- database as well as on the site, because the anon key is public and anyone can query these views directly.
--  * public_runs masked nothing before: failure class, signature and every step's stderr were readable for any
--    failing run, confirmed or not. A failing run's detail is now published only when a CONFIRMED incident covers
--    it (from the incident's first failing run until it resolved). Runs that are about us, not the vendor
--    (CRAWL_ERROR / COMPILER_ERROR before execution, HARNESS_ERROR) keep their class.
--  * public_run_history is new: one light row per (cycle, tool) final run, newest 60 per tool, for the dot strips.
--    It has no column that could carry a cause.
--  * public_tools gains the latest final run (id, outcome, level reached, skip reason) so the home page can tell a
--    tool that needs a person (a manual step) from one that fails, and decided_30d, the count behind the pass rate.
--  * public_runs gains what the run page shows: the plan's compiler version and truncation, the stale-plan flag, and
--    the docs blocks the plan was built from (so each step can show its source lines).
--  * public_incidents gains version_diff. It still lists CONFIRMED incidents only.

DROP VIEW "public_tools";--> statement-breakpoint
DROP VIEW "public_runs";--> statement-breakpoint
DROP VIEW "public_incidents";--> statement-breakpoint

CREATE VIEW "public_tools" AS
WITH final_runs AS (
  SELECT DISTINCT ON (r.cycle_id, r.tool_id)
         r.id, r.tool_id, r.outcome, r.started_at, r.reached_level, r.skip_reason,
         (r.outcome = 'FAIL' AND (
            r.failure_class IN ('CRAWL_ERROR', 'COMPILER_ERROR')
            OR r.runner_env ->> 'plan_stale' = 'true'
         )) AS not_a_verdict
  FROM runs r
  JOIN probe_cycles c ON c.id = r.cycle_id
  WHERE c.valid IS TRUE
  ORDER BY r.cycle_id, r.tool_id, r.attempt DESC
),
stats AS (
  SELECT tool_id,
         count(*) FILTER (WHERE outcome = 'PASS') AS passes,
         count(*) FILTER (WHERE outcome IN ('PASS', 'FAIL') AND NOT not_a_verdict) AS decided
  FROM final_runs
  WHERE started_at >= now() - interval '30 days'
  GROUP BY tool_id
),
latest AS (
  SELECT DISTINCT ON (tool_id) tool_id, id, outcome, reached_level, skip_reason
  FROM final_runs
  ORDER BY tool_id, started_at DESC
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
       CASE WHEN t.consecutive_failures > 0 THEN 'fail' ELSE 'pass' END AS streak_kind,
       l.id AS last_run_id,
       l.outcome AS last_outcome,
       l.reached_level AS last_reached_level,
       l.skip_reason AS last_skip_reason,
       COALESCE(s.decided, 0) AS decided_30d
FROM tools t
LEFT JOIN stats s ON s.tool_id = t.id
LEFT JOIN latest l ON l.tool_id = t.id
WHERE t.enabled AND NOT t.is_canary;--> statement-breakpoint

CREATE VIEW "public_run_history" AS
WITH final_runs AS (
  SELECT DISTINCT ON (r.cycle_id, r.tool_id)
         r.id, r.tool_id, r.outcome, r.failure_class, r.reached_level, r.started_at, r.duration_ms,
         COALESCE(r.runner_env ->> 'plan_stale' = 'true', false) AS stale
  FROM runs r
  JOIN probe_cycles c ON c.id = r.cycle_id
  WHERE c.valid IS TRUE
  ORDER BY r.cycle_id, r.tool_id, r.attempt DESC
),
ranked AS (
  SELECT f.*, t.slug, t.level AS target_level,
         row_number() OVER (PARTITION BY f.tool_id ORDER BY f.started_at DESC) AS rn
  FROM final_runs f
  JOIN tools t ON t.id = f.tool_id AND t.enabled AND NOT t.is_canary
)
SELECT id AS run_id,
       slug AS tool_slug,
       started_at,
       outcome,
       CASE
         WHEN outcome = 'PASS' THEN 'pass'
         WHEN outcome = 'SKIPPED' THEN 'skipped'
         WHEN outcome = 'HARNESS_ERROR' THEN 'harness'
         WHEN failure_class IN ('CRAWL_ERROR', 'COMPILER_ERROR') THEN 'not_run'
         ELSE 'fail'
       END AS kind,
       reached_level,
       target_level,
       stale,
       duration_ms,
       rn
FROM ranked
WHERE rn <= 60;--> statement-breakpoint

CREATE VIEW "public_runs" AS
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
       ds.extraction ->> 'url' AS snapshot_url
FROM visible v
LEFT JOIN doc_snapshots ds ON ds.id = v.snapshot_id
LEFT JOIN compiled_plans cp ON cp.id = v.plan_id;--> statement-breakpoint

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
       ), '[]'::jsonb) AS events,
       i.version_diff
FROM incidents i
JOIN tools t ON t.id = i.tool_id AND t.enabled AND NOT t.is_canary
WHERE i.review = 'CONFIRMED';--> statement-breakpoint

GRANT SELECT ON "public_tools", "public_runs", "public_incidents", "public_run_history" TO anon, authenticated;--> statement-breakpoint

NOTIFY pgrst, 'reload schema';
