-- Hand-edited: drizzle-kit emits a bare `SET DATA TYPE inet`, which fails on any legacy
-- non-IP string. Cast through a throwaway safe-cast helper so unparseable values become
-- NULL instead of aborting the migration. ALTER COLUMN TYPE rewrites the table without
-- firing row-level triggers, so the append-only UPDATE trigger does not block it.
CREATE FUNCTION "audit_events_try_inet_0023"(v text) RETURNS inet LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v IS NULL OR v !~ '^[0-9a-fA-F:.]+$' THEN
    RETURN NULL;
  END IF;
  RETURN v::inet;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "ip" SET DATA TYPE inet USING "audit_events_try_inet_0023"("ip");--> statement-breakpoint
DROP FUNCTION "audit_events_try_inet_0023"(text);--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_metadata_object_ck" CHECK (jsonb_typeof("audit_events"."metadata") = 'object');--> statement-breakpoint
-- Hand-added: close the TRUNCATE bypass of the append-only trail. The 0021 function
-- unconditionally raises, so it is valid as a statement-level trigger too.
CREATE TRIGGER "audit_events_no_truncate_trg" BEFORE TRUNCATE ON "audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_append_only"();
