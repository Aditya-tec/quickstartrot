-- "What this check does not cover" (2026-10-19). Never edit this file once applied.
--  * tools.coverage_notes: the sentences coverageNotes() in @qsr/core generates from a target's config (placeholders, tabs, variants, content
--    left out and why). The target sync keeps them current; public_tools carries them as its LAST column so the tool page can say what its
--    check leaves out. Nothing else about the views changes (CREATE OR REPLACE keeps the grants).

ALTER TABLE "tools" ADD COLUMN "coverage_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

CREATE OR REPLACE VIEW "public_tools" AS
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
         WHEN t.history_hidden THEN 'UNKNOWN'::tool_status
         WHEN t.status = 'BROKEN' AND NOT EXISTS (
           SELECT 1 FROM incidents i
           WHERE i.tool_id = t.id AND i.state = 'OPEN' AND i.review = 'CONFIRMED'
         ) THEN 'DEGRADED'::tool_status
         ELSE t.status
       END AS status,
       CASE WHEN NOT t.history_hidden THEN t.status_since END AS status_since,
       CASE WHEN NOT t.history_hidden THEN t.last_run_at END AS last_run_at,
       CASE WHEN NOT t.history_hidden AND s.decided > 0 THEN round(s.passes::numeric / s.decided, 4) END AS pass_rate_30d,
       CASE
         WHEN t.history_hidden THEN NULL
         WHEN t.consecutive_failures > 0 THEN t.consecutive_failures
         ELSE t.consecutive_passes
       END AS current_streak,
       CASE
         WHEN t.history_hidden THEN NULL
         WHEN t.consecutive_failures > 0 THEN 'fail'
         ELSE 'pass'
       END AS streak_kind,
       CASE WHEN NOT t.history_hidden THEN l.id END AS last_run_id,
       CASE WHEN NOT t.history_hidden THEN l.outcome END AS last_outcome,
       CASE WHEN NOT t.history_hidden THEN l.reached_level END AS last_reached_level,
       CASE WHEN NOT t.history_hidden THEN l.skip_reason END AS last_skip_reason,
       CASE WHEN t.history_hidden THEN 0 ELSE COALESCE(s.decided, 0) END AS decided_30d,
       t.opted_out_at,
       t.history_hidden,
       t.coverage_notes
FROM tools t
LEFT JOIN stats s ON s.tool_id = t.id
LEFT JOIN latest l ON l.tool_id = t.id
WHERE (t.enabled OR t.disabled_reason = 'opt_out') AND NOT t.is_canary AND (NOT t.probation OR (SELECT count(DISTINCT pr.cycle_id) FROM runs pr JOIN probe_cycles pc ON pc.id = pr.cycle_id AND pc.valid IS TRUE WHERE pr.tool_id = t.id) >= 2);
--> statement-breakpoint

NOTIFY pgrst, 'reload schema';
