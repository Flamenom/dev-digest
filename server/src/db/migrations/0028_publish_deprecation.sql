ALTER TABLE "review_publication_items" DROP CONSTRAINT "review_publication_items_anchor_kind_ck";--> statement-breakpoint
ALTER TABLE "review_publications" ADD COLUMN "deprecated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "review_publications" ADD COLUMN "deprecation_reason" text;--> statement-breakpoint
ALTER TABLE "review_publications" ADD COLUMN "reviewed_version_found" boolean;--> statement-breakpoint
ALTER TABLE "review_publications" ADD COLUMN "position_fallbacks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_publication_items" ADD CONSTRAINT "review_publication_items_anchor_kind_ck" CHECK ("review_publication_items"."anchor_kind" in ('multi_line', 'single_line', 'general', 'deferred'));--> statement-breakpoint
ALTER TABLE "review_publications" ADD CONSTRAINT "review_publications_deprecation_reason_ck" CHECK ("review_publications"."deprecation_reason" is null or "review_publications"."deprecation_reason" in ('head_moved', 'head_unknown'));--> statement-breakpoint
ALTER TABLE "review_publications" ADD CONSTRAINT "review_publications_deprecation_ck" CHECK ("review_publications"."deprecated" = ("review_publications"."deprecation_reason" is not null));--> statement-breakpoint
ALTER TABLE "review_publications" ADD CONSTRAINT "review_publications_position_fallbacks_ck" CHECK ("review_publications"."position_fallbacks" >= 0);