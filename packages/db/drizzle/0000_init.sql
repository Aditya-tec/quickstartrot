CREATE TYPE "public"."failure_class" AS ENUM('DOCS_SNIPPET_ERROR', 'API_DRIFT', 'DEPENDENCY_RESOLUTION', 'RUNTIME_VERSION', 'NEEDS_CREDENTIALS', 'NETWORK_TRANSIENT', 'TIMEOUT', 'COMPILER_ERROR', 'CRAWL_ERROR', 'HARNESS_ERROR', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."incident_state" AS ENUM('OPEN', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('PENDING_REVIEW', 'CONFIRMED', 'FALSE_POSITIVE');--> statement-breakpoint
CREATE TYPE "public"."run_outcome" AS ENUM('PASS', 'FAIL', 'HARNESS_ERROR', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."tool_status" AS ENUM('UNKNOWN', 'HEALTHY', 'DEGRADED', 'BROKEN');--> statement-breakpoint
CREATE TABLE "compiled_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"compiler_version" text NOT NULL,
	"model" text NOT NULL,
	"ir" jsonb,
	"grounding_report" jsonb NOT NULL,
	"accepted" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compiled_plans_tool_id_content_hash_compiler_version_key" UNIQUE("tool_id","content_hash","compiler_version")
);
--> statement-breakpoint
CREATE TABLE "doc_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"extraction" jsonb NOT NULL,
	"storage_path" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_snapshots_tool_id_content_hash_key" UNIQUE("tool_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"failure_class" "failure_class" NOT NULL,
	"state" "incident_state" DEFAULT 'OPEN' NOT NULL,
	"review" "review_state" DEFAULT 'PENDING_REVIEW' NOT NULL,
	"first_failing_run_id" uuid,
	"last_passing_run_id" uuid,
	"docs_changed" boolean,
	"docs_diff_path" text,
	"summary" text,
	"suggested_fix" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probe_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"git_sha" text NOT NULL,
	"gh_run_id" bigint,
	"canary_ok" boolean,
	"valid" boolean,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"plan_id" uuid,
	"snapshot_id" uuid,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"outcome" "run_outcome" NOT NULL,
	"failure_class" "failure_class",
	"failure_signature" text,
	"failed_step_id" text,
	"classifier_rule" text,
	"image_digest" text NOT NULL,
	"runner_env" jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runs_cycle_id_tool_id_attempt_key" UNIQUE("cycle_id","tool_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "step_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"exit_code" integer,
	"duration_ms" integer NOT NULL,
	"stdout_tail" text,
	"stderr_tail" text,
	"log_path" text
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"docs_url" text NOT NULL,
	"contact" text,
	"note" text,
	"ip_hash" text NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"docs_url" text NOT NULL,
	"language" text NOT NULL,
	"level" smallint NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" "tool_status" DEFAULT 'UNKNOWN' NOT NULL,
	"status_since" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_passes" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tools_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tools_language_check" CHECK ("tools"."language" in ('node','python')),
	CONSTRAINT "tools_level_check" CHECK ("tools"."level" between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "compiled_plans" ADD CONSTRAINT "compiled_plans_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_snapshots" ADD CONSTRAINT "doc_snapshots_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_first_failing_run_id_runs_id_fk" FOREIGN KEY ("first_failing_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_last_passing_run_id_runs_id_fk" FOREIGN KEY ("last_passing_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cycle_id_probe_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."probe_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_plan_id_compiled_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."compiled_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_snapshot_id_doc_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."doc_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_results" ADD CONSTRAINT "step_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_incident_per_tool" ON "incidents" USING btree ("tool_id") WHERE "incidents"."state" = 'OPEN';--> statement-breakpoint
CREATE INDEX "runs_tool_id_started_at_idx" ON "runs" USING btree ("tool_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_cycle_id_idx" ON "runs" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "step_results_run_id_ordinal_idx" ON "step_results" USING btree ("run_id","ordinal");