ALTER TABLE "tools" ADD COLUMN "transient_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "last_failure_signature" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "last_failure_class" "failure_class";