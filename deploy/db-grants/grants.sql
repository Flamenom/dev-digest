-- DevDigest runtime-role grants — idempotent, safe to re-run any number of times.
--
-- Applied ONLY by the one-shot `migrate` service AFTER `db:migrate && db:bootstrap`
-- (deploy/db-grants/apply-grants.mjs), on every `docker compose up`. That single
-- path creates the role on a fresh volume, re-keys it on rotation, fixes volumes
-- created before this file existed and covers tables added by every later
-- migration. Postgres init does NOT create the role (no runtime secret in the
-- long-lived postgres container env).
--
-- Must run as the owner/superuser role (POSTGRES_USER = `devdigest`). The app
-- password is NOT in this file: the caller sets the session GUC
-- `devdigest.app_password` (from APP_DB_PASSWORD) before running it.
--
-- Runtime role `devdigest_app`:
--   LOGIN, NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS,
--   member of no role, owner of nothing.
--   CONNECT on the database, USAGE on schema public (no CREATE).
--   SELECT/INSERT/UPDATE/DELETE on every table in public; USAGE/SELECT on sequences.
--   audit_events: SELECT + INSERT only.
--   No TRUNCATE / REFERENCES / TRIGGER anywhere. No access to schema `drizzle`
--   (migration bookkeeping is migrate-only).
-- Non-owner + non-superuser means it cannot ALTER/DROP/DISABLE triggers, set
-- session_replication_role, or COPY … TO/FROM PROGRAM. Advisory locks need no grant.

BEGIN;

-- 0. Preconditions + role (create or re-key: the password follows APP_DB_PASSWORD
--    on every run, which is how rotation works).
DO $$
DECLARE
  pw text := current_setting('devdigest.app_password', true);
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'grants.sql must run as the owner/superuser role, not %', current_user;
  END IF;
  -- Never echo the value: messages name the setting only.
  IF pw IS NULL OR pw = '' THEN
    RAISE EXCEPTION 'APP_DB_PASSWORD is missing';
  END IF;
  IF pw ~* 'replace-?me' THEN
    RAISE EXCEPTION 'APP_DB_PASSWORD is still the .env.example placeholder; generate one with: openssl rand -hex 24';
  END IF;
  -- `openssl rand -hex 24` = 48 hex chars. URL-safe charset (it is embedded in DATABASE_URL).
  IF pw !~ '^[A-Za-z0-9_-]{32,}$' THEN
    RAISE EXCEPTION 'APP_DB_PASSWORD must be >= 32 chars of [A-Za-z0-9_-]; generate one with: openssl rand -hex 24';
  END IF;
  IF current_user = 'devdigest_app' THEN
    RAISE EXCEPTION 'owner role and runtime role must differ';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devdigest_app') THEN
    EXECUTE format('CREATE ROLE devdigest_app LOGIN PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE devdigest_app PASSWORD %L', pw);
  END IF;
  ALTER ROLE devdigest_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

  -- Fail closed: a membership (e.g. pg_execute_server_program, the owner role) or
  -- any owned object would re-open what this file closes.
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'devdigest_app'::regrole) THEN
    RAISE EXCEPTION 'devdigest_app must not be a member of any role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_shdepend
             WHERE refclassid = 'pg_authid'::regclass
               AND refobjid = 'devdigest_app'::regrole
               AND deptype = 'o') THEN
    RAISE EXCEPTION 'devdigest_app must not own any object';
  END IF;
END
$$;

-- 1. Database: only the two roles connect; no TEMP for PUBLIC.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM devdigest_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO devdigest_app', current_database());
END
$$;

-- 2. Schemas: public = USAGE only; drizzle (migration bookkeeping) = nothing.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM devdigest_app;
GRANT USAGE ON SCHEMA public TO devdigest_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
    REVOKE ALL ON SCHEMA drizzle FROM devdigest_app;
    REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM devdigest_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA drizzle FROM PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA drizzle FROM devdigest_app;
  END IF;
END
$$;

-- 3. Existing objects: reset to exactly the allowed set (REVOKE ALL first drops any
--    TRUNCATE/REFERENCES/TRIGGER or column grant left over from before).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM devdigest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO devdigest_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM devdigest_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devdigest_app;

-- 4. audit_events is append-only for the app (the 0021/0023 triggers are the second
--    line; privileges are the first). Same transaction as step 3, so no committed
--    state ever has audit_events with UPDATE/DELETE for the app.
DO $$
BEGIN
  IF to_regclass('public.audit_events') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.audit_events FROM devdigest_app;
    REVOKE ALL ON TABLE public.audit_events FROM PUBLIC;
    GRANT SELECT, INSERT ON TABLE public.audit_events TO devdigest_app;
  END IF;
END
$$;

-- 5. Future objects created by the owner (every later migration).
--    TABLES: NO default privileges — fail closed. `db:migrate` runs in its own
--    transaction before this file; with a DML default, a table it creates (e.g. a
--    re-created audit_events or a new append-only table) would be committed with
--    UPDATE/DELETE for the app until step 3/4 narrowed it, and an already-running
--    api (re-run `up -d` while the old api keeps serving) could use that window.
--    Without a default, a new table is inaccessible to the app until steps 3 + 4
--    grant exactly the allowed set in ONE transaction. The freshly started api
--    never sees the gap: it starts only after `migrate` exits 0
--    (compose: api depends_on migrate: service_completed_successfully).
--    SEQUENCES: USAGE/SELECT by default (no write/DDL power, no window concern).
DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                 'REVOKE ALL ON TABLES FROM devdigest_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                 'REVOKE ALL ON SEQUENCES FROM devdigest_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                 'GRANT USAGE, SELECT ON SEQUENCES TO devdigest_app', current_user);
END
$$;

COMMIT;
