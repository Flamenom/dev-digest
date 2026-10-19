#!/usr/bin/env bash
# Postgres first-boot init (runs ONLY on an empty data volume, as POSTGRES_USER
# over the local socket). Creates the runtime role `devdigest_app` and its
# default privileges by applying the same idempotent file the `migrate` service
# re-applies after every migration: /opt/devdigest/db-grants/grants.sql.
#
# The password is read with psql's \getenv from APP_DB_PASSWORD — it is never
# put on a command line (argv is visible in `ps`) or into the SQL file.
set -euo pipefail

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "10-app-role.sh: APP_DB_PASSWORD is not set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -X --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password APP_DB_PASSWORD
SELECT set_config('devdigest.app_password', :'app_password', false) \gset discard_
\unset app_password
\i /opt/devdigest/db-grants/grants.sql
SELECT set_config('devdigest.app_password', '', false) \gset discard_
SQL
