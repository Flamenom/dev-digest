-- Hand-annotated: since 0024 settings are workspace-wide (user_id = first author only), so
-- deleting that user must NULL the author, not cascade-delete the workspace's setting; the FK
-- gets its own index (0024 dropped the unique index that covered user_id). The sessions
-- last_seen_at index is dropped: touch() writes that column on the request path and the
-- index would block HOT updates; the idle sweep is a LIMIT-bounded periodic scan instead.
ALTER TABLE "settings" DROP CONSTRAINT "settings_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "sessions_last_seen_at_idx";--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settings_user_idx" ON "settings" USING btree ("user_id");