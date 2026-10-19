DROP INDEX "repos_ws_fullname_uq";--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "host" text DEFAULT 'github.com' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "pr_files" ADD COLUMN "previous_path" text;--> statement-breakpoint
ALTER TABLE "pr_files" ADD COLUMN "change_type" text;--> statement-breakpoint
ALTER TABLE "pr_files" ADD COLUMN "patch_omitted" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "is_draft" boolean;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "stats_known" boolean;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "detail_head_sha" text;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_ws_provider_host_fullname_uq" ON "repos" USING btree ("workspace_id","provider","host","full_name");--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_provider_ck" CHECK ("repos"."provider" in ('github', 'gitlab'));