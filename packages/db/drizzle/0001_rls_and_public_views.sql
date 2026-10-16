-- Spec section 5, "Public read path (RLS)".
-- RLS on every base table with NO policies for anon: base tables are invisible to the public key.
-- The web app reads only the three views below, owned by postgres (security_invoker is off, so the
-- views read base tables with the owner's rights while anon has no rights on the tables).

ALTER TABLE "tools" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compiled_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "probe_cycles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "step_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Defense in depth: Supabase grants anon/authenticated broad default privileges on new objects.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;--> statement-breakpoint

-- public_tools: public status shows BROKEN only when the open incident is CONFIRMED; an
-- unreviewed internal BROKEN shows as DEGRADED ("verifying"). Pass rate and streak ignore runs
-- from invalid cycles and count only the final attempt of each (cycle, tool).
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
WHERE t.enabled;--> statement-breakpoint

-- public_runs: last 90 days of runs for enabled tools, with their step results, excluding runs
-- from invalid (or unfinished) cycles. Plan and grounding report back the /runs/[id] page.
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
JOIN tools t ON t.id = r.tool_id AND t.enabled
JOIN probe_cycles c ON c.id = r.cycle_id AND c.valid IS TRUE
LEFT JOIN doc_snapshots ds ON ds.id = r.snapshot_id
LEFT JOIN compiled_plans cp ON cp.id = r.plan_id
WHERE r.started_at >= now() - interval '90 days';--> statement-breakpoint

-- public_incidents: CONFIRMED incidents plus their events. Internal 'note' events stay private.
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
JOIN tools t ON t.id = i.tool_id AND t.enabled
WHERE i.review = 'CONFIRMED';--> statement-breakpoint

GRANT SELECT ON "public_tools", "public_runs", "public_incidents" TO anon, authenticated;--> statement-breakpoint

NOTIFY pgrst, 'reload schema';
