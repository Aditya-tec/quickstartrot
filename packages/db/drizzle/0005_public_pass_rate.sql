-- P7. Never edit this file once applied.
-- public_tools.pass_rate_30d counted every FAIL as a verdict on the vendor. Two kinds of FAIL are not:
--  * a run that never reached the executor (failure_class CRAWL_ERROR or COMPILER_ERROR, recorded since P7
--    so the history shows them);
--  * a FAIL on a stale plan (runner_env.plan_stale = 'true'): the model was not asked, so the plan may simply
--    be out of date. The status engine ignores both as evidence (spec section 10); the pass rate now does too.
-- A PASS always counts, including on a stale plan. Only this view changes.

DROP VIEW "public_tools";--> statement-breakpoint
CREATE VIEW "public_tools" AS
WITH final_runs AS (
  SELECT DISTINCT ON (r.cycle_id, r.tool_id) r.tool_id, r.outcome, r.started_at,
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
GRANT SELECT ON "public_tools" TO anon, authenticated;--> statement-breakpoint

NOTIFY pgrst, 'reload schema';
