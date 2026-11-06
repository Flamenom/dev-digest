#!/usr/bin/env bash
#
# Mutation harness for deploy/check-compose.sh (no containers are started; needs
# the docker CLI with the compose plugin, node and perl).
#
#   bash deploy/tests/check-compose.test.sh
#
# Copies compose.yml / Caddyfile / a generated runbook / .env.example plus a
# generated env file with CANARY secret values into a scratch dir, runs the
# unmutated set once (must pass), then applies one mutation per case and asserts
# that check-compose.sh exits non-zero with the matching FAIL line.
# deploy/.env is never read.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
CHECK="$DEPLOY/check-compose.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/check-compose-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Shell env overrides compose interpolation: drop every deployment setting so
# only the scratch env files decide.
while IFS= read -r k; do unset "$k" || true; done < <(sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' "$DEPLOY/.env.example")
unset DEVDIGEST_RELEASE DEVDIGEST_IMAGE_TAG CHECK_SECRETS \
  COMPOSE_FILE_OVERRIDE CADDYFILE_OVERRIDE RUNBOOK_OVERRIDE ENV_EXAMPLE_OVERRIDE || true

# Canary secrets (never real; must never appear in output).
CANARY_PG="canaryPG_0123456789abcdef0123456789abcdef"
CANARY_APP="canaryAPP_0123456789abcdef0123456789abcdef"
CANARY_BACKUP="canaryBACKUP_0123456789abcdef0123456789abcdef"
CANARY_GSECRET="canaryGOOGLE_secret_value"
CANARY_MASTER="canaryMASTERkey0123456789abcdef0123456789abcd="

BASE="$WORK/base"
mkdir -p "$BASE"
cp "$DEPLOY/compose.yml" "$BASE/compose.yml"
cp "$DEPLOY/Caddyfile" "$BASE/Caddyfile"
cp "$DEPLOY/.env.example" "$BASE/env.example"
cat > "$BASE/deployment.md" <<'EOF'
# Deployment (test fixture)

## Settings reference

| Setting | Secret | Required | Default |
|---|---|---|---|
| `PUBLIC_HOSTNAME` | no | yes | — |
| `BACKUP_DB_PASSWORD` | yes | yes | — |
| `SENTRY_WEB_DSN` | no | no | empty |
| `DEVDIGEST_RELEASE` | no | no | state file only (skipped) |

## Next section

| `NOT_A_SETTING_HERE` | ignored outside the section |
EOF
perl -pe "
  s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$CANARY_PG/;
  s/^APP_DB_PASSWORD=.*/APP_DB_PASSWORD=$CANARY_APP/;
  s/^BACKUP_DB_PASSWORD=.*/BACKUP_DB_PASSWORD=$CANARY_BACKUP/;
  s/^GOOGLE_CLIENT_ID=.*/GOOGLE_CLIENT_ID=canary-client.apps.googleusercontent.com/;
  s/^GOOGLE_CLIENT_SECRET=.*/GOOGLE_CLIENT_SECRET=$CANARY_GSECRET/;
  s/^SECRETS_MASTER_KEY=.*/SECRETS_MASTER_KEY=$CANARY_MASTER/;
" "$DEPLOY/.env.example" > "$BASE/test.env"

pass=0; failn=0
ok()  { echo "  ok  $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1" >&2; failn=$((failn + 1)); }

# run_case <dir> → runs check-compose.sh against the files in <dir>; sets OUT and RC.
run_case() {
  local d="$1"
  set +e
  OUT="$(COMPOSE_FILE_OVERRIDE="$d/compose.yml" CADDYFILE_OVERRIDE="$d/Caddyfile" \
    RUNBOOK_OVERRIDE="$d/deployment.md" ENV_EXAMPLE_OVERRIDE="$d/env.example" \
    bash "$CHECK" "$d/test.env" 2>&1)"
  RC=$?
  set -e
}

no_canary_in_output() {
  local c
  for c in "$CANARY_PG" "$CANARY_APP" "$CANARY_BACKUP" "$CANARY_GSECRET" "$CANARY_MASTER" replace-me-backup; do
    case "$OUT" in *"$c"*) return 1 ;; esac
  done
  return 0
}

# mutate <name> <file-in-dir> <perl -0 substitution> <expected FAIL fragment> [extra env-file line]
mutate() {
  local name="$1" file="$2" expr="$3" expect="$4" envline="${5:-}"
  local d="$WORK/$(printf '%s' "$name" | tr -c 'A-Za-z0-9' '_')"
  cp -R "$BASE" "$d"
  if [ -n "$expr" ]; then
    perl -0pi -e "$expr" "$d/$file"
    if cmp -s "$BASE/$file" "$d/$file"; then bad "$name: mutation did not change $file"; return; fi
  fi
  [ -z "$envline" ] || printf '%s\n' "$envline" >> "$d/test.env"
  run_case "$d"
  if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -F "FAIL" | grep -Fq -- "$expect"; then
    ok "$name → FAIL ($expect)"
  else
    bad "$name: expected non-zero exit and a FAIL containing \"$expect\" (exit $RC)"
    printf '%s\n' "$OUT" | grep -E 'FAIL|error' | sed 's/^/        /' >&2 || true
  fi
  no_canary_in_output || bad "$name: a secret value leaked into the output"
}

echo "▸ unmutated set passes (canary env, secret checks on)"
run_case "$BASE"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q '✔ all deployment checks passed' \
  && printf '%s' "$OUT" | grep -Fq 'every setting in the runbook'; then
  ok "baseline passes (incl. AC-8 runbook check and secret checks)"
else
  bad "baseline failed (exit $RC)"; printf '%s\n' "$OUT" | grep -E 'FAIL|error' | sed 's/^/        /' >&2 || true
fi
no_canary_in_output || bad "baseline: a secret value leaked into the output"

echo "▸ positive: CSP connect-src that allows the web DSN origin passes"
d="$WORK/csp_ok"; cp -R "$BASE" "$d"
perl -pi -e "s/form-action 'self'\"/form-action 'self'; connect-src 'self' https:\/\/o1.ingest.sentry.io\"/" "$d/Caddyfile"
printf '%s\n' 'SENTRY_WEB_DSN=https://publickey@o1.ingest.sentry.io/1' >> "$d/test.env"
run_case "$d"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -Fq 'CSP connect-src allows the web DSN origin'; then ok "connect-src with the DSN origin → ok"
else bad "connect-src with the DSN origin should pass (exit $RC)"; fi

echo "▸ .env.example with placeholders fails when forced (names only)"
set +e
OUT="$(CHECK_SECRETS=1 bash "$CHECK" "$DEPLOY/.env.example" 2>&1)"; RC=$?
set -e
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -F FAIL | grep -Fq BACKUP_DB_PASSWORD; then ok "CHECK_SECRETS=1 .env.example → FAIL names BACKUP_DB_PASSWORD"
else bad "CHECK_SECRETS=1 .env.example should fail naming BACKUP_DB_PASSWORD (exit $RC)"; fi
no_canary_in_output || bad "CHECK_SECRETS=1: a placeholder value was printed"

echo "▸ mutations"
mutate "backup publishes a port" compose.yml \
  's/^  backup:\n/  backup:\n    ports:\n      - "5433:5432"\n/m' \
  "backup has no published ports"
mutate "backup on edge" compose.yml \
  's{(      - \./backup:/opt/devdigest/backup:ro\n    networks:\n)      - db\n}{$1      - edge\n      - db\n}' \
  'backup only on network "db"'
mutate "backup PGUSER is the owner" compose.yml \
  's/PGUSER: devdigest_backup/PGUSER: devdigest/' \
  "backup PGUSER is the read-only devdigest_backup role"
mutate "backup env gains SENTRY_DSN" compose.yml \
  's/(      TZ: UTC\n)/$1      SENTRY_DSN: \$\{SENTRY_DSN:-\}\n/' \
  "backup env has no secret-like key but BACKUP_DB_PASSWORD"
mutate "backup image postgres:17" compose.yml \
  's{^(  backup:\n    image: )pgvector/pgvector:0\.8\.1-pg16}{${1}postgres:17}m' \
  "backup image has the postgres major version"
mutate "backup without restart" compose.yml \
  's/    restart: unless-stopped\n    init: true\n/    init: true\n/' \
  "backup restart: unless-stopped"
mutate "backup without a healthcheck" compose.yml \
  's{    healthcheck:\n      test: \["CMD", "sh", "/opt/devdigest/backup/devdigest-backup\.sh", "health"\]\n(      \S.*\n)+}{}' \
  "backup has a healthcheck"
mutate "proxy without logging" compose.yml \
  's/    logging: \*logging\n//' \
  "proxy log rotation"
mutate "web without a memory limit" compose.yml \
  's/          memory: \$\{WEB_MEM_LIMIT:-512m\}\n//' \
  "web resource limits"
mutate "web build arg carries SENTRY_DSN" compose.yml \
  's/(        NEXT_PUBLIC_API_BASE: \/api\n)/$1        SENTRY_DSN: \$\{SENTRY_DSN:-\}\n/' \
  "web build args have no SENTRY_DSN"
mutate "Caddyfile connect-src 'self' with a web DSN" Caddyfile \
  "s/form-action 'self'\"/form-action 'self'; connect-src 'self'\"/" \
  "CSP (Content-Security-Policy connect-src)" \
  'SENTRY_WEB_DSN=https://publickey@o1.ingest.sentry.io/1'
mutate "runbook names FOO_BAR" deployment.md \
  's/(\| `SENTRY_WEB_DSN` \|[^\n]*\n)/$1| `FOO_BAR` | no | no | — |\n/' \
  "FOO_BAR"
mutate ".env.example key without its comment line" env.example \
  's/# non-secret optional default: info\n(LOG_LEVEL=)/$1/' \
  "LOG_LEVEL"
mutate "BACKUP_DB_PASSWORD equals APP_DB_PASSWORD" test.env \
  "s/^BACKUP_DB_PASSWORD=.*\$/BACKUP_DB_PASSWORD=$CANARY_APP/m" \
  "BACKUP_DB_PASSWORD differs from POSTGRES_PASSWORD and APP_DB_PASSWORD"

echo
if [ "$failn" -eq 0 ]; then echo "✔ check-compose.test.sh: $pass passed"; exit 0
else echo "✘ check-compose.test.sh: $failn failed, $pass passed" >&2; exit 1; fi
