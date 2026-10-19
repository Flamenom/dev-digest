CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_name_len_ck" CHECK (char_length("api_tokens"."name") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "encrypted_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key_name" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "encrypted_secrets_nonce_len_ck" CHECK (octet_length("encrypted_secrets"."nonce") = 12)
);
--> statement-breakpoint
CREATE TABLE "oauth_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"binding_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text DEFAULT '/' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "status_changed_by" uuid;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "joined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "acted_by" uuid;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "author_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "author_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "initiated_by" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_secrets" ADD CONSTRAINT "encrypted_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_secrets" ADD CONSTRAINT "encrypted_secrets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_uq" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_active_idx" ON "api_tokens" USING btree ("user_id") WHERE "api_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "audit_events_ws_created_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "encrypted_secrets_ws_key_uq" ON "encrypted_secrets" USING btree ("workspace_id","key_name");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_flows_state_hash_uq" ON "oauth_flows" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_id_hash_uq" ON "sessions" USING btree ("id_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_acted_by_users_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_uq" ON "users" USING btree ("google_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_lower_email_uq" ON "users" USING btree (lower("email")) WHERE "users"."google_sub" is not null;--> statement-breakpoint
CREATE INDEX "findings_acted_by_idx" ON "findings" USING btree ("acted_by");--> statement-breakpoint
CREATE INDEX "skill_versions_author_idx" ON "skill_versions" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "skills_created_by_idx" ON "skills" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "skills_updated_by_idx" ON "skills" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "agent_versions_author_idx" ON "agent_versions" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "agents_created_by_idx" ON "agents" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "agents_updated_by_idx" ON "agents" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "eval_cases_created_by_idx" ON "eval_cases" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "agent_runs_initiated_by_idx" ON "agent_runs" USING btree ("initiated_by");--> statement-breakpoint
-- Hand-added (AC-48): the ONLY rewrite of existing data — the legacy membership role `owner`
-- becomes `admin`. Runs before the role CHECK below so existing rows satisfy it.
UPDATE "workspace_members" SET "role" = 'admin' WHERE "role" = 'owner';--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_ck" CHECK ("workspace_members"."role" in ('admin', 'member'));--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_status_ck" CHECK ("workspace_members"."status" in ('active', 'deactivated'));--> statement-breakpoint
-- Hand-added: audit_events is append-only. Any UPDATE or DELETE raises (TRUNCATE is a
-- separate, privileged operation and is not row-level).
CREATE FUNCTION "audit_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only_trg" BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
