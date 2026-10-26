CREATE TABLE "review_publication_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"code" text,
	"anchor_kind" text NOT NULL,
	"draft_id" bigint,
	"discussion_id" text,
	"note_id" bigint,
	"url" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "review_publication_items_state_ck" CHECK ("review_publication_items"."state" in ('pending', 'drafted', 'published', 'failed', 'rolled_back')),
	CONSTRAINT "review_publication_items_anchor_kind_ck" CHECK ("review_publication_items"."anchor_kind" in ('multi_line', 'single_line', 'general')),
	CONSTRAINT "review_publication_items_url_ck" CHECK ("review_publication_items"."url" is null or "review_publication_items"."url" like 'https://%')
);
--> statement-breakpoint
CREATE TABLE "review_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"pr_id" uuid NOT NULL,
	"created_by" uuid,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"code" text,
	"message" text,
	"requested" integer NOT NULL,
	"drafted" integer DEFAULT 0 NOT NULL,
	"published" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"general_notes" integer DEFAULT 0 NOT NULL,
	"applicable_suggestions" integer DEFAULT 0 NOT NULL,
	"other_drafts_published" integer DEFAULT 0 NOT NULL,
	"has_summary" boolean NOT NULL,
	"apply_suggestions" boolean DEFAULT false NOT NULL,
	"diff_head_sha" text,
	"bulk_publish_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "review_publications_status_ck" CHECK ("review_publications"."status" in ('in_progress', 'published', 'partially_published', 'failed', 'unconfirmed')),
	CONSTRAINT "review_publications_counters_ck" CHECK ("review_publications"."drafted" >= 0 and "review_publications"."published" >= 0 and "review_publications"."failed" >= 0 and "review_publications"."general_notes" >= 0 and "review_publications"."applicable_suggestions" >= 0 and "review_publications"."other_drafts_published" >= 0),
	CONSTRAINT "review_publications_requested_ck" CHECK ("review_publications"."requested" between 1 and 50),
	CONSTRAINT "review_publications_totals_ck" CHECK ("review_publications"."published" + "review_publications"."failed" <= "review_publications"."requested"),
	CONSTRAINT "review_publications_finished_ck" CHECK (not ("review_publications"."status" in ('published', 'partially_published', 'failed')) or "review_publications"."finished_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "review_publication_items" ADD CONSTRAINT "review_publication_items_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_items" ADD CONSTRAINT "review_publication_items_publication_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."review_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publications" ADD CONSTRAINT "review_publications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publications" ADD CONSTRAINT "review_publications_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publications" ADD CONSTRAINT "review_publications_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publications" ADD CONSTRAINT "review_publications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_items_publication_finding_uq" ON "review_publication_items" USING btree ("publication_id","finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_items_finding_live_uq" ON "review_publication_items" USING btree ("finding_id") WHERE "review_publication_items"."state" in ('pending', 'drafted', 'published');--> statement-breakpoint
CREATE INDEX "review_publication_items_finding_idx" ON "review_publication_items" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "review_publication_items_publication_position_idx" ON "review_publication_items" USING btree ("publication_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publications_pr_in_progress_uq" ON "review_publications" USING btree ("pr_id") WHERE "review_publications"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "review_publications_review_created_idx" ON "review_publications" USING btree ("review_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "review_publications_reconcile_idx" ON "review_publications" USING btree ("status","updated_at") WHERE "review_publications"."status" in ('in_progress', 'unconfirmed');--> statement-breakpoint
CREATE INDEX "review_publications_workspace_idx" ON "review_publications" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "review_publications_created_by_idx" ON "review_publications" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "review_publications_pr_idx" ON "review_publications" USING btree ("pr_id");