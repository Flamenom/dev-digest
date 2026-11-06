-- DevDigest read-only backup role — idempotent, safe to re-run any number of times.
--
-- Applied ONLY by the one-shot `migrate` service, right AFTER grants.sql, in the
-- same `apply-grants.mjs` run (on every `docker compose up`). grants.sql runs
-- `REVOKE ALL ON DATABASE … FROM PUBLIC` every time, so this file must run after
-- it and re-grant CONNECT every time.
--
-- Must run as the owner/superuser role (POSTGRES_USER = `devdigest`). The backup
-- password is NOT in this file: the caller sets the session GUC
-- `devdigest.backup_password` (from BACKUP_DB_PASSWORD) as a bound parameter
-- before running it, and clears it afterwards.
--
-- Backup role `devdigest_backup` (used by the `backup` service's pg_dump):
--   LOGIN, NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS,
--   member of pg_read_all_data ONLY (PG >= 14: SELECT on every table/sequence and
--   USAGE on every schema, including `drizzle`, the migrations journal), owner of
--   nothing, default_transaction_read_only = on.
--   CONNECT on the database; no TEMP, no CREATE anywhere, no direct object grant.
-- Every write and DDL statement fails for it (no privilege), even after it turns
-- `default_transaction_read_only` off in its own session.

BEGIN;

-- 0. Preconditions + role (create or re-key: the password follows
--    BACKUP_DB_PASSWORD on every run, which is how rotation works).
DO $$
DECLARE
  pw text := current_setting('devdigest.backup_password', true);
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'backup-role.sql must run as the owner/superuser role, not %', current_user;
  END IF;
  -- Never echo the value: messages name the setting only.
  IF pw IS NULL OR pw = '' THEN
    RAISE EXCEPTION 'BACKUP_DB_PASSWORD is missing';
  END IF;
  IF pw ~* 'replace-?me' THEN
    RAISE EXCEPTION 'BACKUP_DB_PASSWORD is still the .env.example placeholder; generate one with: openssl rand -hex 24';
  END IF;
  -- `openssl rand -hex 24` = 48 hex chars. Same charset as the other DB passwords
  -- (and safe in a libpq passfile without escaping).
  IF pw !~ '^[A-Za-z0-9_-]{32,}$' THEN
    RAISE EXCEPTION 'BACKUP_DB_PASSWORD must be >= 32 chars of [A-Za-z0-9_-]; generate one with: openssl rand -hex 24';
  END IF;
  IF current_user = 'devdigest_backup' THEN
    RAISE EXCEPTION 'owner role and backup role must differ';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devdigest_backup') THEN
    EXECUTE format('CREATE ROLE devdigest_backup LOGIN PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE devdigest_backup PASSWORD %L', pw);
  END IF;
  ALTER ROLE devdigest_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END
$$;

-- 1. Read everything: the predefined role, nothing else.
GRANT pg_read_all_data TO devdigest_backup;

-- 2. Fail closed: any other membership (e.g. pg_write_all_data, the owner role,
--    pg_execute_server_program) or any owned object would re-open writes / DDL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members
             WHERE member = 'devdigest_backup'::regrole
               AND roleid <> 'pg_read_all_data'::regrole) THEN
    RAISE EXCEPTION 'devdigest_backup must not be a member of any role other than pg_read_all_data';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members
             WHERE member = 'devdigest_backup'::regrole AND admin_option) THEN
    RAISE EXCEPTION 'devdigest_backup must not hold ADMIN OPTION on any role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_shdepend
             WHERE refclassid = 'pg_authid'::regclass
               AND refobjid = 'devdigest_backup'::regrole
               AND deptype = 'o') THEN
    RAISE EXCEPTION 'devdigest_backup must not own any object';
  END IF;
END
$$;

-- 3. Read-only by default (defence in depth: privileges are the first line).
ALTER ROLE devdigest_backup SET default_transaction_read_only = on;

-- 4. Database: CONNECT only (no TEMP, no CREATE). Re-granted on every run because
--    grants.sql revokes everything from PUBLIC first.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM devdigest_backup', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO devdigest_backup', current_database());
END
$$;

-- 5. No direct grant anywhere: reading comes from pg_read_all_data only, so reset
--    any schema / table / sequence grant left over from before.
REVOKE ALL ON SCHEMA public FROM devdigest_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM devdigest_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM devdigest_backup;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    REVOKE ALL ON SCHEMA drizzle FROM devdigest_backup;
    REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM devdigest_backup;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA drizzle FROM devdigest_backup;
  END IF;
END
$$;

COMMIT;
