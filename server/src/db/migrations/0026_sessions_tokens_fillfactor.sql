-- Hand-written (drizzle-orm 0.38's pgTable cannot express table storage parameters, so
-- this lives in SQL only; see the notes on `sessions` / `apiTokens` in schema/identity.ts).
-- Both tables are update-heavy on non-indexed columns: every authenticated request touches
-- `sessions.last_seen_at` (throttled) and every bearer call `api_tokens.last_used_at`.
-- fillfactor = 90 leaves 10% free space per heap page so those updates can stay HOT
-- (same page, no index maintenance). Only affects pages written from now on; existing
-- pages are repacked by the next VACUUM FULL / CLUSTER, which is not required.
ALTER TABLE "sessions" SET (fillfactor = 90);--> statement-breakpoint
ALTER TABLE "api_tokens" SET (fillfactor = 90);
