DROP INDEX "settings_ws_user_key_uq";--> statement-breakpoint
-- Hand-added: settings are workspace-wide, but the old (workspace, user, key) index let
-- each Admin hold a shadow row per key whose values could differ. Collapse them to ONE row
-- per (workspace_id, key) before the new unique index, keeping the most recently written
-- row. `settings` has no timestamp column, so recency is the row version's age(xmin)
-- (smallest = written by the newest transaction; age() is wraparound-safe), with id as a
-- deterministic final tiebreak. The DROP INDEX above already holds ACCESS EXCLUSIVE on
-- the table, so no writer can slip a new duplicate in before the index exists.
DELETE FROM "settings" s
USING (
  SELECT "id", row_number() OVER (
    PARTITION BY "workspace_id", "key"
    ORDER BY age(xmin) ASC, "id" DESC
  ) AS rn
  FROM "settings"
) ranked
WHERE s."id" = ranked."id" AND ranked.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "settings_ws_key_uq" ON "settings" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "encrypted_secrets_key_id_idx" ON "encrypted_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "sessions_last_seen_at_idx" ON "sessions" USING btree ("last_seen_at");
