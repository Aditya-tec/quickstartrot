-- P6: columns the status engine and the admin tools need (see 0003 for why this is a second migration).
--  * runs.reached_level / runs.skip_reason: StatusRun inputs; RunResult has them, spec section 5 did not.
--  * tools.disabled_reason: file_removed (a re-sync may re-enable) vs admin (it must not).
ALTER TABLE "runs" ADD COLUMN "reached_level" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "disabled_reason" text;