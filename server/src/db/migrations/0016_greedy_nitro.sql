ALTER TABLE "pr_brief" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "tokens_in" integer;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "tokens_out" integer;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_brief" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;