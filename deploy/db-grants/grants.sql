-- DevDigest runtime-role grants — idempotent, safe to re-run any number of times.
--
-- Applied by:
--   1. postgres init (fresh volume only): deploy/postgres-init/10-app-role.sh
--   2. the one-shot `migrate` service AFTER `db:migrate && db:bootstrap`
--      (deploy/db-grants/apply-grants.mjs) — covers volumes created before this
--      file existed and tables added by every later migration.
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
  IF pw IS NULL OR length(pw) < 16 THEN
    RAISE EXCEPTION 'APP_DB_PASSWORD is missing or shorter than 16 characters';
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
--    line; privileges are the first). Absent on a fresh volume at init time.
DO $$
BEGIN
  IF to_regclass('public.audit_events') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.audit_events FROM devdigest_app;
    REVOKE ALL ON TABLE public.audit_events FROM PUBLIC;
    GRANT SELECT, INSERT ON TABLE public.audit_events TO devdigest_app;
  END IF;
END
$$;

-- 5. Future objects created by the owner (every later migration). audit_events'
--    narrowing is re-applied by step 4 on each migrate run.
DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                 'REVOKE ALL ON TABLES FROM devdigest_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devdigest_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                 'REVOKE ALL ON SEQUENCES FROM devdigest_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                 'GRANT USAGE, SELECT ON SEQUENCES TO devdigest_app', current_user);
END
$$;

COMMIT;
