#!/usr/bin/env bash
# Scenario tests for deploy/update.sh (AC-9 – AC-21). No Docker daemon, no network,
# and the real repo's git state is never touched: every scenario builds a scratch
# bare "origin", a "dev" clone that pushes new commits, and a "vm" clone that runs
# a copy of update.sh / dc.sh with stub check-compose.sh / smoke.sh and the fake
# docker from lib/fake-docker.sh on PATH.
#
#   bash deploy/tests/update.test.sh        → one "ok <scenario>" line each; exit 0 = all green
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_SRC=$(cd "$HERE/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/devdigest-update-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# Isolate git from the user's config (hooks, signing, default branch…).
export GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.name "Update Test"
git config --file "$GIT_CONFIG_GLOBAL" user.email "update-test@example.test"
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
git config --file "$GIT_CONFIG_GLOBAL" advice.detachedHead false

CANARIES="CANARY_google_secret_9f3a CANARY_master_key_77c1 CANARY_app_db_pw_51de CANARY_owner_db_pw_0b2c CANARY_backup_db_pw_e4a8 CANARY_sentry_dsn_c3d1"
FAILED=0
CURRENT=""
SCEN_FAIL=0

check() { # <description> <command…>
  local d="$1"; shift
  if ! "$@"; then
    echo "  FAIL [$CURRENT] $d"
    SCEN_FAIL=1
  fi
}
contains() { grep -qF -- "$2" "$1"; }
not_contains() { ! grep -qF -- "$2" "$1"; }
eq() { [ "$1" = "$2" ]; }

journal_json() { # n entries
  local i=0 sep=""
  printf '{\n  "version": "7",\n  "dialect": "postgresql",\n  "entries": ['
  while [ "$i" -lt "$1" ]; do
    printf '%s\n    { "idx": %d, "version": "7", "when": %d, "tag": "%04d_m", "breakpoints": true }' "$sep" "$i" "$i" "$i"
    sep=","; i=$((i + 1))
  done
  printf '\n  ]\n}\n'
}

setup() {
  T=$(mktemp -d "$WORK/s.XXXXXX")
  ORIGIN="$T/origin.git"; DEV="$T/dev"; VM="$T/vm"; S="$T/docker"; BIN="$T/bin"
  mkdir -p "$S" "$BIN"
  cp "$HERE/lib/fake-docker.sh" "$BIN/docker"; chmod +x "$BIN/docker"
  git init -q --bare "$ORIGIN"
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  git init -q "$DEV"
  mkdir -p "$DEV/deploy" "$DEV/server/src/db/migrations/meta"
  cp "$DEPLOY_SRC/update.sh" "$DEPLOY_SRC/dc.sh" "$DEV/deploy/"
  cat > "$DEV/deploy/check-compose.sh" <<'EOF'
#!/usr/bin/env bash
[ -f "$FAKE_DOCKER_STATE/fail_check" ] && { echo "FAIL missing BACKUP_DB_PASSWORD"; exit 1; }
echo "ok check-compose"
EOF
  cat > "$DEV/deploy/smoke.sh" <<'EOF'
#!/usr/bin/env bash
echo "${SMOKE_RESOLVE_IP:-unset} $*" >> "$FAKE_DOCKER_STATE/smoke.log"
[ -f "$FAKE_DOCKER_STATE/fail_smoke" ] && { echo "FAIL ready"; exit 1; }
echo "ok web-html"
EOF
  echo "services: {}" > "$DEV/deploy/compose.yml"
  echo "-- init" > "$DEV/server/src/db/migrations/0000_init.sql"
  journal_json 1 > "$DEV/server/src/db/migrations/meta/_journal.json"
  printf 'deploy/.env\ndeploy/.state/\ndeploy/backups/\n' > "$DEV/.gitignore"
  git -C "$DEV" add -A && git -C "$DEV" commit -qm "initial"
  git -C "$DEV" remote add origin "$ORIGIN"
  git -C "$DEV" push -q origin main
  git clone -q "$ORIGIN" "$VM"
  mkdir -p "$VM/deploy/backups"
  cat > "$VM/deploy/.env" <<'EOF'
PUBLIC_HOSTNAME=devdigest.example.test
GOOGLE_CLIENT_ID=client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=CANARY_google_secret_9f3a
SECRETS_MASTER_KEY=CANARY_master_key_77c1
APP_DB_PASSWORD=CANARY_app_db_pw_51de
POSTGRES_PASSWORD=CANARY_owner_db_pw_0b2c
BACKUP_DB_PASSWORD=CANARY_backup_db_pw_e4a8
SENTRY_DSN=https://CANARY_sentry_dsn_c3d1@o1.ingest.sentry.io/1
UPDATE_HEALTH_TIMEOUT=2
EOF
  echo 1 > "$S/journal_count"
  printf 'devdigest-api:local\ndevdigest-web:local\n' > "$S/images"
  : > "$S/calls.log"
  PREV=$(git -C "$VM" rev-parse HEAD)
}

dev_commit() { # <message> [<path> <content>]…
  local msg="$1"; shift
  while [ "$#" -ge 2 ]; do
    mkdir -p "$(dirname "$DEV/$1")"
    printf '%s\n' "$2" > "$DEV/$1"
    shift 2
  done
  git -C "$DEV" add -A && git -C "$DEV" commit -qm "$msg" --allow-empty && git -C "$DEV" push -q origin main
  NEW=$(git -C "$DEV" rev-parse HEAD)
}
dev_add_migration() {
  dev_commit "add migration" \
    server/src/db/migrations/0001_new.sql "-- new" \
    server/src/db/migrations/meta/_journal.json "$(journal_json 2)"
}

run_update() { # [args…] → RC, OUT
  OUT="$T/out.$RANDOM"
  (cd "$VM" && PATH="$BIN:$PATH" FAKE_DOCKER_STATE="$S" DEVDIGEST_BACKUP_UID="$(id -u)" \
    DEVDIGEST_UPDATE_POLL_INTERVAL=1 bash deploy/update.sh "$@") > "$OUT" 2>&1
  RC=$?
  cp "$OUT" "$T/last.out"
  ALL_OUTPUT="$ALL_OUTPUT $OUT"
}
head_sha() { git -C "$VM" rev-parse HEAD; }
docker_calls() { grep -c -- "$1" "$S/calls.log" || true; }
no_mutating_docker() {
  ! grep -E ' (compose -f compose.yml (run|up|build|stop|down)|image (tag|rm|prune)|builder prune)' "$S/calls.log" >/dev/null
}
no_canary() {
  local f c
  for f in "$T"/out.*; do
    for c in $CANARIES; do grep -qF "$c" "$f" && return 1; done
  done
  return 0
}

scenario() { # <name> <function>
  CURRENT="$1"; SCEN_FAIL=0; ALL_OUTPUT=""
  setup
  "$2"
  check "no secret canary in the output" no_canary
  if [ "$SCEN_FAIL" = 0 ]; then echo "ok $1"; else
    FAILED=1
    echo "  --- last output ($1, exit $RC) ---"; sed 's/^/  | /' "$T/last.out"
  fi
}

# ---------------------------------------------------------------- scenarios
s_help() {
  RC=0; OUT="$T/out.help"; bash "$DEPLOY_SRC/update.sh" --help > "$OUT" 2>&1 || RC=$?
  cp "$OUT" "$T/last.out"
  check "exit 0" eq "$RC" 0
  check "mentions forward-only" contains "$OUT" "forward-only"
  check "mentions restore" contains "$OUT" "restore"
  check "has the exit-code table" contains "$OUT" "3  deployed, unhealthy, and migrations were applied"
}

s_preflight_env() {
  dev_commit "new"; rm "$VM/deploy/.env"
  run_update
  check "exit 1" eq "$RC" 1
  check "names deploy/.env" contains "$OUT" "deploy/.env not found"
  check "HEAD unchanged" eq "$(head_sha)" "$PREV"
  check "no docker call" eq "$(wc -l < "$S/calls.log" | tr -d ' ')" 0
}
s_preflight_dirty() {
  dev_commit "new"; echo "# local edit" >> "$VM/deploy/compose.yml"
  run_update
  check "exit 1" eq "$RC" 1
  check "names local changes" contains "$OUT" "tracked files have local changes"
  check "HEAD unchanged" eq "$(head_sha)" "$PREV"
  check "no docker call" eq "$(wc -l < "$S/calls.log" | tr -d ' ')" 0
}
s_preflight_staged() {
  dev_commit "new"; echo "x" > "$VM/newfile"; git -C "$VM" add newfile
  run_update
  check "exit 1" eq "$RC" 1
  check "names local changes" contains "$OUT" "tracked files have local changes"
  check "HEAD unchanged" eq "$(head_sha)" "$PREV"
}
s_preflight_branch() {
  dev_commit "new"; git -C "$VM" checkout -q -b hotfix
  run_update
  check "exit 1" eq "$RC" 1
  check "names the deploy branch" contains "$OUT" "not on the deploy branch 'main'"
  check "HEAD unchanged" eq "$(head_sha)" "$PREV"
  check "no docker call" eq "$(wc -l < "$S/calls.log" | tr -d ' ')" 0
}
s_preflight_lock() {
  dev_commit "new"
  mkdir -p "$VM/deploy/.state/update.lock.d"; echo "$$" > "$VM/deploy/.state/update.lock.d/pid"
  run_update
  check "exit 1" eq "$RC" 1
  check "names the lock" contains "$OUT" "another update or rollback is running"
  check "HEAD unchanged" eq "$(head_sha)" "$PREV"
  check "no docker call" eq "$(wc -l < "$S/calls.log" | tr -d ' ')" 0
  check "foreign lock left in place" test -f "$VM/deploy/.state/update.lock.d/pid"
}
s_preflight_backup_dir() {
  dev_commit "new"; rmdir "$VM/deploy/backups"
  run_update
  check "exit 1" eq "$RC" 1
  check "names the backup dir + fix" contains "$OUT" "sudo install -d -m 0700 -o 999 -g 999"
  check "HEAD unchanged" eq "$(head_sha)" "$PREV"
  check "no docker call" eq "$(wc -l < "$S/calls.log" | tr -d ' ')" 0
}
s_stale_lock() {
  mkdir -p "$VM/deploy/.state/update.lock.d"; echo "999999" > "$VM/deploy/.state/update.lock.d/pid"
  run_update
  check "exit 0" eq "$RC" 0
  check "stale lock removed" contains "$OUT" "removing a stale update lock"
  check "lock released on exit" test ! -e "$VM/deploy/.state/update.lock.d"
}
s_up_to_date() {
  local start=$SECONDS
  run_update
  check "exit 0" eq "$RC" 0
  check "says already up to date" contains "$OUT" "already up to date"
  check "no dump" eq "$(docker_calls 'dump pre-update')" 0
  check "no docker mutation" no_mutating_docker
  check "< 30 s" test $((SECONDS - start)) -lt 30
  check "lock released" test ! -e "$VM/deploy/.state/update.lock.d"
  run_update
  check "second run also exit 0" eq "$RC" 0
}
s_dump_failure() {
  dev_commit "new"; touch "$S/fail_dump"
  run_update
  check "exit 1" eq "$RC" 1
  check "names the dump failure" contains "$OUT" "pre-update dump failed"
  check "HEAD unchanged" eq "$(head_sha)" "$PREV"
  check "no update.env" test ! -e "$VM/deploy/.state/update.env"
  check "no build / up" eq "$(docker_calls 'compose.yml build')$(docker_calls 'compose.yml up')" "00"
}
s_diverged() {
  dev_commit "remote work"
  echo "local" > "$VM/local.txt"; git -C "$VM" add local.txt; git -C "$VM" commit -qm "local work"
  PREV=$(head_sha)
  run_update
  check "exit 1" eq "$RC" 1
  check "names the divergence" contains "$OUT" "diverged"
  check "HEAD unchanged" eq "$(head_sha)" "$PREV"
  check "no build" eq "$(docker_calls 'compose.yml build')" 0
}
s_check_failure() {
  dev_commit "new"; touch "$S/fail_check"
  run_update
  check "exit 1" eq "$RC" 1
  check "names check-compose" contains "$OUT" "check-compose.sh failed"
  check "HEAD == prev" eq "$(head_sha)" "$PREV"
  check "no build / up" eq "$(docker_calls 'compose.yml build')$(docker_calls 'compose.yml up')" "00"
}
s_build_failure() {
  dev_commit "new"; touch "$S/fail_build"
  run_update
  check "exit 1" eq "$RC" 1
  check "names the build" contains "$OUT" "image build failed"
  check "HEAD == prev" eq "$(head_sha)" "$PREV"
  check "no up" eq "$(docker_calls 'compose.yml up')" 0
  check "update.env restored (absent)" test ! -e "$VM/deploy/.state/update.env"
  check "release.env untouched" test ! -e "$VM/deploy/.state/release.env"
}
s_success() {
  # The new commit rewrites update.sh itself: the run must not execute it mid-flight.
  dev_commit "release" deploy/update.sh 'echo HIJACKED; exit 42' web.txt "v2"
  run_update
  local p12="${PREV:0:12}" n12="${NEW:0:12}" env="$VM/deploy/.state/update.env"
  check "exit 0" eq "$RC" 0
  check "HEAD == new" eq "$(head_sha)" "$NEW"
  check "not hijacked by the rewritten script" not_contains "$OUT" "HIJACKED"
  check "prints old → new" contains "$OUT" "$p12 → $n12"
  check "prints smoke: ok" contains "$OUT" "smoke: ok"
  check "no stop api" eq "$(docker_calls 'compose.yml stop')" 0
  check "update.env previous_sha" contains "$env" "previous_sha=$PREV"
  check "update.env current_sha" contains "$env" "current_sha=$NEW"
  check "update.env dump" contains "$env" "pre_update_dump=devdigest-20261106T031500Z-pre-update-${PREV:0:7}.dump"
  check "update.env migrations_applied=false" contains "$env" "migrations_applied=false"
  check "release.env = new" contains "$VM/deploy/.state/release.env" "DEVDIGEST_IMAGE_TAG=$n12"
  check "built with the new tag" grep -q "^$n12 compose -f compose.yml build" "$S/calls.log"
  check "up ran with the new tag (dc.sh)" grep -q "^$n12 compose -f compose.yml up -d" "$S/calls.log"
  check "smoke via 127.0.0.1" grep -qx "127.0.0.1 devdigest.example.test" "$S/smoke.log"
  check "previous images kept as :$p12" grep -qx "devdigest-api:$p12" "$S/images"
  check "new images re-tagged :local" contains "$S/calls.log" "image tag devdigest-web:$n12 devdigest-web:local"
  check "lock released" test ! -e "$VM/deploy/.state/update.lock.d"
}
s_migration() {
  dev_add_migration; echo 1 > "$S/migrate_adds"
  run_update
  check "exit 0" eq "$RC" 0
  local stop_line up_line
  stop_line=$(grep -n 'compose.yml stop api' "$S/calls.log" | head -1 | cut -d: -f1)
  up_line=$(grep -n 'compose.yml up -d' "$S/calls.log" | head -1 | cut -d: -f1)
  check "stop api called" test -n "$stop_line"
  check "stop api precedes up" test "${stop_line:-999}" -lt "${up_line:-0}"
  check "migrations_applied=true" contains "$VM/deploy/.state/update.env" "migrations_applied=true"
}
s_health_fail_no_migration() {
  dev_commit "broken release" web.txt "v2"; echo unhealthy > "$S/health_after_up_1"
  run_update
  check "exit 2" eq "$RC" 2
  check "HEAD == prev" eq "$(head_sha)" "$PREV"
  check "up called twice" eq "$(docker_calls 'compose.yml up -d')" 2
  check "no rebuild (prev images kept)" eq "$(docker_calls 'compose.yml build')" 1
  check "says rolled back to <sha>" contains "$OUT" "rolled back to ${PREV:0:12}"
  check "release.env back to prev" contains "$VM/deploy/.state/release.env" "DEVDIGEST_RELEASE=$PREV"
  check "second up used the prev tag" grep -q "^${PREV:0:12} compose -f compose.yml up -d" "$S/calls.log"
}
s_smoke_fail_no_migration() {
  dev_commit "release" web.txt "v2"; touch "$S/fail_smoke"
  run_update
  check "exit 2" eq "$RC" 2
  check "HEAD == prev" eq "$(head_sha)" "$PREV"
  check "says rolled back" contains "$OUT" "rolled back to ${PREV:0:12}"
}
s_health_fail_after_migration() {
  dev_add_migration; echo 1 > "$S/migrate_adds"; echo unhealthy > "$S/health_after_up_1"
  run_update
  check "exit 3" eq "$RC" 3
  check "names the dump" contains "$OUT" "devdigest-20261106T031500Z-pre-update-${PREV:0:7}.dump"
  check "names the prev sha" contains "$OUT" "git reset --hard $PREV"
  check "warns about data loss" contains "$OUT" "is lost by the restore"
  check "up called once" eq "$(docker_calls 'compose.yml up -d')" 1
  check "no restore executed" eq "$(docker_calls 'pg_restore')$(docker_calls 'DROP DATABASE')$(docker_calls 'stop api web backup')" "000"
  check "HEAD stays on new" eq "$(head_sha)" "$NEW"
  check "migrations_applied=true" contains "$VM/deploy/.state/update.env" "migrations_applied=true"
}
s_rollback_db_ahead() {
  dev_add_migration; echo 1 > "$S/migrate_adds"
  run_update
  check "update exit 0" eq "$RC" 0
  run_update rollback
  check "rollback exit 1" eq "$RC" 1
  check "names the dump" contains "$OUT" "pre-update-${PREV:0:7}.dump"
  check "points to the restore procedure" contains "$OUT" "Backup & restore"
  check "HEAD stays on new" eq "$(head_sha)" "$NEW"
}
s_rollback_ok() {
  dev_commit "release" web.txt "v2"
  run_update
  check "update exit 0" eq "$RC" 0
  local ups; ups=$(docker_calls 'compose.yml up -d')
  run_update rollback
  check "rollback exit 0" eq "$RC" 0
  check "HEAD == prev" eq "$(head_sha)" "$PREV"
  check "redeployed" eq "$(docker_calls 'compose.yml up -d')" $((ups + 1))
  check "release.env = prev" contains "$VM/deploy/.state/release.env" "DEVDIGEST_RELEASE=$PREV"
  check "on the deploy branch" eq "$(git -C "$VM" symbolic-ref --short HEAD)" main
  run_update
  check "a later update fast-forwards again" eq "$(head_sha)" "$NEW"
}
s_prune() {
  printf 'devdigest-api:0ld0ld0ld0ld\ndevdigest-web:0ld0ld0ld0ld\ndevdigest-api:another\n' >> "$S/images"
  dev_commit "release" web.txt "v2"
  run_update
  check "exit 0" eq "$RC" 0
  local api web
  api=$(grep '^devdigest-api:' "$S/images" | sort | tr '\n' ' ')
  web=$(grep '^devdigest-web:' "$S/images" | sort | tr '\n' ' ')
  local expect_api expect_web
  expect_api=$(printf 'devdigest-api:%s\ndevdigest-api:%s\ndevdigest-api:local\n' "${NEW:0:12}" "${PREV:0:12}" | sort | tr '\n' ' ')
  expect_web=$(printf 'devdigest-web:%s\ndevdigest-web:%s\ndevdigest-web:local\n' "${NEW:0:12}" "${PREV:0:12}" | sort | tr '\n' ' ')
  check "api keeps exactly new, prev, local" eq "$api" "$expect_api"
  check "web keeps exactly new, prev, local" eq "$web" "$expect_web"
  check "builder prune bounded" contains "$S/calls.log" "builder prune -f --keep-storage"
}
s_canary_all() {
  # Every scenario above already asserts no canary leaked; this one also runs a
  # failing path whose output includes compose/smoke errors.
  dev_add_migration; echo 1 > "$S/migrate_adds"; touch "$S/fail_up"
  run_update
  check "exit 3 (migrate applied, up failed)" eq "$RC" 3
  check "no canary" no_canary
}

scenario "help: forward-only, exit codes, restore" s_help
scenario "preflight: missing deploy/.env" s_preflight_env
scenario "preflight: dirty tracked tree" s_preflight_dirty
scenario "preflight: staged change" s_preflight_staged
scenario "preflight: wrong branch" s_preflight_branch
scenario "preflight: lock held" s_preflight_lock
scenario "preflight: backup dir missing" s_preflight_backup_dir
scenario "stale lock is cleared" s_stale_lock
scenario "already up to date" s_up_to_date
scenario "dump failure aborts with nothing changed" s_dump_failure
scenario "diverged branch aborts" s_diverged
scenario "check-compose failure resets the checkout" s_check_failure
scenario "build failure resets the checkout" s_build_failure
scenario "successful update without migrations (self-rewrite safe)" s_success
scenario "new migration: stop api precedes up" s_migration
scenario "health failure without migration: auto-rollback (exit 2)" s_health_fail_no_migration
scenario "smoke failure without migration: auto-rollback (exit 2)" s_smoke_fail_no_migration
scenario "health failure after migration: guided restore (exit 3)" s_health_fail_after_migration
scenario "rollback refused when the DB is ahead" s_rollback_db_ahead
scenario "rollback after a migration-free update" s_rollback_ok
scenario "prune keeps exactly new, prev, local" s_prune
scenario "canary secrets never in output" s_canary_all

if [ "$FAILED" = 0 ]; then echo "all update.sh scenarios passed"; exit 0; fi
echo "update.sh scenarios FAILED"; exit 1
