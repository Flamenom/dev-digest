#!/usr/bin/env bash
# deploy/update.sh — safe update / rollback of the single-VM deployment.
# Run `deploy/update.sh --help` for the contract. Spec: specs/2026-11-06-production-readiness.md
# (AC-9 – AC-21); runbook: docs/deployment.md.
#
# Security notes (AC-21):
#   - deploy/.env is NEVER sourced. Only the non-secret keys listed in read_settings
#     are read, one by one, with grep.
#   - every git / docker call goes through `run` (or is captured and parsed), so its
#     output is prefixed and never mixed with secrets read by this script (it reads none).
#   - `set -x` is never used.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/update.sh [update|rollback] [--help]

Modes
  update    (default) Fast-forward the checkout to DEPLOY_REMOTE/DEPLOY_BRANCH and
            redeploy it:
              preflight → pre-update dump → fast-forward → check-compose + build
              (old containers keep serving) → [stop api if the new commit adds
              migrations] → up -d (migrate runs) → wait for api + web healthy →
              smoke check. Success prints "<old> → <new>" and "smoke: ok".
  rollback  Redeploy the previous commit recorded by the last update
            (deploy/.state/update.env). Refuses when the database has migrations
            that commit does not know; restore the named pre-update dump instead.

Exit codes
  0  success, or already up to date
  1  preflight / check / build failure, or refused — nothing new deployed
  2  deployed but unhealthy — automatically rolled back to the previous commit
  3  deployed, unhealthy, and migrations were applied — manual restore required
     (the commands are printed; the database is NOT touched automatically)

Migrations are forward-only. Rolling back over a migration means restoring the
pre-update dump, and everything written since that dump (reviews, comments,
settings, audit events, sessions) is lost. See "Backup & restore" in
docs/deployment.md for the restore procedure.

Settings read from deploy/.env (non-secret keys only; the file is never sourced):
  DEPLOY_BRANCH (main) · DEPLOY_REMOTE (origin) · UPDATE_HEALTH_TIMEOUT (180 s)
  PUBLIC_HOSTNAME (required) · BACKUP_DIR (./backups, relative to deploy/)

Requirements: git, Docker Engine with Compose v2, node (also needed by
check-compose.sh). The backup dir must exist and be owned by uid 999
(sudo install -d -m 0700 -o 999 -g 999 <BACKUP_DIR>).

State (git-ignored, deploy/.state/): release.env (deployed sha + image tag, read by
deploy/dc.sh), update.env (previous_sha, current_sha, pre_update_dump,
migrations_applied), update.lock.d (one update/rollback at a time).
A rollback (automatic or by the `rollback` mode) resets the deploy branch to the
previous commit; the next `update` fast-forwards it to the remote again.
EOF
}

case "${1:-}" in
  -h|--help|help) usage; exit 0 ;;
esac

# --- Re-exec from a temp copy: the fast-forward may rewrite this very file while
# bash is still reading it. -------------------------------------------------------
if [ -z "${DEVDIGEST_UPDATE_REEXEC:-}" ]; then
  __self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  __self="$__self_dir/$(basename "${BASH_SOURCE[0]}")"
  __copy=$(mktemp "${TMPDIR:-/tmp}/devdigest-update.XXXXXX")
  cp "$__self" "$__copy"
  DEVDIGEST_UPDATE_REEXEC="$__copy" DEVDIGEST_UPDATE_SELF="$__self" exec bash "$__copy" "$@"
fi

MODE="${1:-update}"
if [ "$#" -gt 1 ]; then
  usage >&2
  rm -f "$DEVDIGEST_UPDATE_REEXEC"
  exit 1
fi
case "$MODE" in
  update|rollback) ;;
  *) usage >&2; rm -f "$DEVDIGEST_UPDATE_REEXEC"; exit 1 ;;
esac

SELF="$DEVDIGEST_UPDATE_SELF"
DEPLOY_DIR=$(cd "$(dirname "$SELF")" && pwd)
ENV_FILE="$DEPLOY_DIR/.env"
STATE_DIR="$DEPLOY_DIR/.state"
LOCK_DIR="$STATE_DIR/update.lock.d"
UPDATE_ENV="$STATE_DIR/update.env"
RELEASE_ENV="$STATE_DIR/release.env"
DC="$DEPLOY_DIR/dc.sh"
JOURNAL_PATH="server/src/db/migrations/meta/_journal.json"
# Owner uid of the backup dir (the postgres uid of the pgvector image). Overridable
# only for the test harness.
BACKUP_UID="${DEVDIGEST_BACKUP_UID:-999}"
POLL_INTERVAL="${DEVDIGEST_UPDATE_POLL_INTERVAL:-5}"
export GIT_TERMINAL_PROMPT=0

LOCK_HELD=0
REPO=""

log() { printf 'update: %s\n' "$*"; }
die() { log "ERROR: $1"; exit "${2:-1}"; }

cleanup() {
  if [ "$LOCK_HELD" = 1 ]; then rm -rf "$LOCK_DIR"; fi
  rm -f "$DEVDIGEST_UPDATE_REEXEC"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Run a command, prefixing every stdout/stderr line. Returns the command's status.
run() {
  if "$@" 2>&1 | sed -e 's/^/update:   | /'; then return 0; else return $?; fi
}

git_() { git -C "$REPO" "$@"; }

# Read one non-secret key from deploy/.env (last assignment wins, quotes stripped).
env_key() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
  v="${v%$'\r'}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

read_settings() {
  DEPLOY_BRANCH=$(env_key DEPLOY_BRANCH); DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
  DEPLOY_REMOTE=$(env_key DEPLOY_REMOTE); DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
  HEALTH_TIMEOUT=$(env_key UPDATE_HEALTH_TIMEOUT); HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
  PUBLIC_HOSTNAME=$(env_key PUBLIC_HOSTNAME)
  BACKUP_DIR=$(env_key BACKUP_DIR); BACKUP_DIR="${BACKUP_DIR:-./backups}"

  [[ $DEPLOY_BRANCH =~ ^[A-Za-z0-9._/-]+$ ]] || die "DEPLOY_BRANCH in deploy/.env is not a valid branch name"
  [[ $DEPLOY_REMOTE =~ ^[A-Za-z0-9._-]+$ ]] || die "DEPLOY_REMOTE in deploy/.env is not a valid remote name"
  [[ $HEALTH_TIMEOUT =~ ^[0-9]+$ ]] || die "UPDATE_HEALTH_TIMEOUT in deploy/.env must be a number of seconds"
  [[ $PUBLIC_HOSTNAME =~ ^[A-Za-z0-9.-]+$ ]] || die "PUBLIC_HOSTNAME in deploy/.env is missing or not a bare host name"
  case "$BACKUP_DIR" in
    /*) BACKUP_DIR_ABS="$BACKUP_DIR" ;;
    *) BACKUP_DIR_ABS="$DEPLOY_DIR/${BACKUP_DIR#./}" ;;
  esac
}

file_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1"; }

acquire_lock() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    local pid
    pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      die "another update or rollback is running (lock $LOCK_DIR held by pid $pid)"
    fi
    log "removing a stale update lock (pid ${pid:-unknown} is not running)"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || die "another update or rollback is running (could not take $LOCK_DIR)"
  fi
  LOCK_HELD=1
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

# AC-9: every refusal has its own message, exits 1, and changes nothing.
preflight() {
  [ -f "$ENV_FILE" ] || die "deploy/.env not found ($ENV_FILE) — copy deploy/.env.example and fill it in first"
  REPO=$(git -C "$DEPLOY_DIR" rev-parse --show-toplevel 2>/dev/null) || die "$DEPLOY_DIR is not inside a git checkout"
  read_settings
  if ! git_ diff --quiet HEAD -- || ! git_ diff --cached --quiet --; then
    die "tracked files have local changes — commit or discard them first (git status)"
  fi
  local branch
  branch=$(git_ symbolic-ref --quiet --short HEAD 2>/dev/null || echo "(detached HEAD)")
  if [ "$branch" != "$DEPLOY_BRANCH" ]; then
    die "the checkout is on '$branch', not on the deploy branch '$DEPLOY_BRANCH' (git checkout $DEPLOY_BRANCH)"
  fi
  if [ ! -d "$BACKUP_DIR_ABS" ]; then
    die "backup dir $BACKUP_DIR_ABS does not exist — sudo install -d -m 0700 -o 999 -g 999 $BACKUP_DIR_ABS"
  fi
  if [ "$(file_uid "$BACKUP_DIR_ABS")" != "$BACKUP_UID" ]; then
    die "backup dir $BACKUP_DIR_ABS is not owned by uid $BACKUP_UID — sudo chown 999:999 $BACKUP_DIR_ABS && sudo chmod 0700 $BACKUP_DIR_ABS"
  fi
  acquire_lock
}

# --- state files --------------------------------------------------------------
STATE_SNAPSHOT=""
STATE_EXISTED=0
snapshot_state() {
  if [ -f "$UPDATE_ENV" ]; then STATE_EXISTED=1; STATE_SNAPSHOT=$(cat "$UPDATE_ENV"); fi
}
restore_state() {
  if [ "$STATE_EXISTED" = 1 ]; then
    (umask 077; printf '%s\n' "$STATE_SNAPSHOT" > "$UPDATE_ENV.tmp") && mv "$UPDATE_ENV.tmp" "$UPDATE_ENV"
  else
    rm -f "$UPDATE_ENV"
  fi
}
write_update_env() { # previous current dump applied
  (umask 077; printf 'previous_sha=%s\ncurrent_sha=%s\npre_update_dump=%s\nmigrations_applied=%s\n' \
    "$1" "$2" "$3" "$4" > "$UPDATE_ENV.tmp")
  mv "$UPDATE_ENV.tmp" "$UPDATE_ENV"
}
state_key() { grep -E "^$1=" "$UPDATE_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
write_release_env() { # full sha
  (umask 077; printf 'DEVDIGEST_RELEASE=%s\nDEVDIGEST_IMAGE_TAG=%s\n' "$1" "${1:0:12}" > "$RELEASE_ENV.tmp")
  mv "$RELEASE_ENV.tmp" "$RELEASE_ENV"
}
current_image_tag() {
  local t=""
  [ -f "$RELEASE_ENV" ] && t=$(grep -E '^DEVDIGEST_IMAGE_TAG=' "$RELEASE_ENV" | tail -1 | cut -d= -f2- || true)
  [[ $t =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || t=local
  printf '%s' "$t"
}

# --- docker helpers -------------------------------------------------------------
image_exists() { docker image inspect "$1" >/dev/null 2>&1; }
images_exist() { image_exists "devdigest-api:$1" && image_exists "devdigest-web:$1"; }

build_images() { # full sha
  DEVDIGEST_IMAGE_TAG="${1:0:12}" DEVDIGEST_RELEASE="$1" run "$DC" build
}

# Number of rows in drizzle's migrations journal, read through the read-only backup
# role. The password comes from the backup container's own environment (never argv).
db_migration_count() {
  local script out
  script='export PGPASSWORD="$BACKUP_DB_PASSWORD"; exec psql -X -w -tA -c "select count(*) from drizzle.__drizzle_migrations"'
  if ! out=$("$DC" exec -T backup sh -c "$script" 2>/dev/null); then
    out=$("$DC" run --rm -T --no-deps --entrypoint sh backup -c "$script" 2>/dev/null) || return 1
  fi
  out=$(printf '%s' "$out" | tr -d '[:space:]')
  [[ $out =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$out"
}

# Print "api=<health> web=<health>" from `compose ps --format json` (a JSON array
# before Compose 2.21, NDJSON after).
service_health() {
  "$DC" ps --format json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let rows = [];
      s = s.trim();
      if (s.startsWith("[")) { try { rows = JSON.parse(s); } catch { rows = []; } }
      else for (const l of s.split("\n")) { try { rows.push(JSON.parse(l)); } catch {} }
      const h = {};
      for (const r of rows) if (r && r.Service) h[r.Service] = r.Health || r.State || "unknown";
      process.stdout.write(["api", "web"].map((k) => k + "=" + (h[k] || "missing")).join(" "));
    });'
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) status last=""
  log "waiting up to ${HEALTH_TIMEOUT}s for api + web to be healthy"
  while :; do
    status=$(service_health || true)
    if [ "$status" != "$last" ]; then log "  $status"; last="$status"; fi
    [ "$status" = "api=healthy web=healthy" ] && return 0
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep "$POLL_INTERVAL"
  done
}

smoke() {
  log "smoke check against $PUBLIC_HOSTNAME (via 127.0.0.1)"
  SMOKE_RESOLVE_IP=127.0.0.1 run bash "$DEPLOY_DIR/smoke.sh" "$PUBLIC_HOSTNAME"
}

prune_images() { # keep tags…
  local repo tag keep
  for repo in devdigest-api devdigest-web; do
    for tag in $(docker image ls --format '{{.Tag}}' "$repo" 2>/dev/null || true); do
      [ "$tag" = "<none>" ] && continue
      keep=0
      for k in "$@"; do [ "$tag" = "$k" ] && keep=1; done
      [ "$keep" = 1 ] && continue
      run docker image rm "$repo:$tag" || log "warning: could not remove $repo:$tag"
    done
  done
  run docker image prune -f || log "warning: docker image prune failed"
  local flag="--keep-storage"
  if docker builder prune --help 2>/dev/null | grep -q -- '--reserved-space'; then flag="--reserved-space"; fi
  run docker builder prune -f "$flag" 2gb || log "warning: docker builder prune failed"
}

# --- failure paths ----------------------------------------------------------------
print_restore_commands() { # prev dump
  local prev="$1" dump="$2" dump_path="$BACKUP_DIR_ABS/$2"
  log "Restore the pre-update dump and redeploy the previous commit (run from $REPO):"
  log "  1. deploy/dc.sh stop api web backup"
  log "  2. deploy/dc.sh exec -T postgres psql -U devdigest -d postgres -c 'DROP DATABASE devdigest WITH (FORCE)' -c 'CREATE DATABASE devdigest OWNER devdigest'"
  log "  3. sudo cat $dump_path | deploy/dc.sh exec -T postgres pg_restore -U devdigest -d devdigest --no-owner --no-privileges"
  log "  4. git reset --hard $prev"
  log "  5. printf 'DEVDIGEST_RELEASE=%s\\nDEVDIGEST_IMAGE_TAG=%s\\n' $prev ${prev:0:12} > deploy/.state/release.env"
  log "  6. deploy/dc.sh up -d"
  log "  7. bash deploy/smoke.sh $PUBLIC_HOSTNAME"
  log "WARNING: everything written after the dump $dump (reviews, comments, settings,"
  log "audit events, sessions) is lost by the restore. Restore with the SAME SECRETS_MASTER_KEY."
}

# Redeploy <sha> (checkout already reset). Returns 0 when healthy.
redeploy() {
  local sha="$1" tag="${1:0:12}"
  write_release_env "$sha"
  if ! images_exist "$tag"; then
    log "images for $tag are missing — rebuilding them"
    build_images "$sha" || return 1
  fi
  run "$DC" up -d || return 1
  wait_healthy
}

# AC-16 / AC-17
deploy_failed() { # reason
  log "ERROR: the new version is not healthy: $1"
  if [ "$MIGRATIONS_APPLIED" = true ]; then
    log "ERROR: migrations were applied — the database is NOT restored automatically."
    log "The site stays on $NEW12 (unhealthy). Pre-update dump: $DUMP"
    print_restore_commands "$PREV" "$DUMP"
    exit 3
  fi
  log "no migration was applied — rolling back to $PREV12"
  run git_ reset --hard "$PREV" || log "ERROR: git reset --hard $PREV failed"
  if redeploy "$PREV"; then
    restore_state
    log "rolled back to $PREV12"
  else
    restore_state
    log "ERROR: rolled back to $PREV12, but it is not healthy either — check 'deploy/dc.sh ps' and 'deploy/dc.sh logs'"
  fi
  exit 2
}

# --- modes ------------------------------------------------------------------------
do_update() {
  PREV=$(git_ rev-parse HEAD)
  PREV12="${PREV:0:12}"
  log "deployed commit: $PREV12 (branch $DEPLOY_BRANCH)"

  run git_ fetch --quiet "$DEPLOY_REMOTE" "$DEPLOY_BRANCH" \
    || die "git fetch $DEPLOY_REMOTE $DEPLOY_BRANCH failed — nothing changed"
  NEW=$(git_ rev-parse FETCH_HEAD)
  NEW12="${NEW:0:12}"

  # AC-10
  if [ "$NEW" = "$PREV" ] || git_ merge-base --is-ancestor "$NEW" "$PREV"; then
    log "already up to date ($PREV12)"
    exit 0
  fi
  # AC-12: refuse before anything else when a fast-forward is impossible.
  if ! git_ merge-base --is-ancestor "$PREV" "$NEW"; then
    die "cannot fast-forward $DEPLOY_BRANCH to $DEPLOY_REMOTE/$DEPLOY_BRANCH ($NEW12): the branches have diverged — HEAD unchanged"
  fi
  log "updating $PREV12 → $NEW12"

  # AC-11: pre-update dump first; a failure changes nothing.
  local out
  log "taking the pre-update dump"
  if ! out=$("$DC" run --rm -T backup dump pre-update "${PREV:0:7}" 2>&1); then
    printf '%s\n' "$out" | sed -e 's/^/update:   | /'
    die "the pre-update dump failed — nothing changed"
  fi
  printf '%s\n' "$out" | sed -e 's/^/update:   | /'
  DUMP=$(printf '%s\n' "$out" | sed -n 's/^dump: //p' | tail -1 | tr -d '\r')
  [[ $DUMP =~ ^[A-Za-z0-9._-]+$ ]] || die "the pre-update dump did not report its file name — nothing changed"
  log "pre-update dump: $DUMP"

  snapshot_state
  write_update_env "$PREV" "$NEW" "$DUMP" false
  MIGRATIONS_APPLIED=false

  # Q2: keep the running images under the previous commit's tag.
  local cur repo
  cur=$(current_image_tag)
  for repo in devdigest-api devdigest-web; do
    if image_exists "$repo:$PREV12"; then continue; fi
    if image_exists "$repo:$cur"; then
      run docker image tag "$repo:$cur" "$repo:$PREV12" || log "warning: could not tag $repo:$PREV12"
    else
      log "warning: no $repo:$cur image to keep — a rollback would rebuild it"
    fi
  done

  # AC-12
  if ! run git_ merge --ff-only "$NEW"; then
    restore_state
    die "fast-forward to $NEW12 failed — HEAD unchanged"
  fi

  # AC-13: check + build while the old containers keep serving.
  if ! run bash "$DEPLOY_DIR/check-compose.sh" "$ENV_FILE"; then
    run git_ reset --hard "$PREV" || true
    restore_state
    die "check-compose.sh failed for $NEW12 — checkout reset to $PREV12, containers untouched"
  fi
  log "building images $NEW12 (the running containers keep serving)"
  if ! build_images "$NEW"; then
    run git_ reset --hard "$PREV" || true
    restore_state
    die "the image build failed for $NEW12 — checkout reset to $PREV12, containers untouched"
  fi

  # AC-14
  local new_migrations count_before="" count_after
  new_migrations=$(git_ diff --name-only --diff-filter=A "$PREV" "$NEW" -- 'server/src/db/migrations/*.sql')
  if [ -n "$new_migrations" ]; then
    log "the new commit adds migrations:"
    printf '%s\n' "$new_migrations" | sed -e 's/^/update:   + /'
    if ! count_before=$(db_migration_count); then
      run git_ reset --hard "$PREV" || true
      restore_state
      die "could not read the applied-migration count through the backup role — checkout reset to $PREV12, containers untouched (is the backup service configured?)"
    fi
    log "applied migrations before: $count_before — stopping api before migrate runs"
    run "$DC" stop api || log "warning: could not stop api"
  fi

  write_release_env "$NEW"
  local up_ok=1
  run "$DC" up -d || up_ok=0

  if [ -n "$new_migrations" ]; then
    if count_after=$(db_migration_count); then
      log "applied migrations after: $count_after"
      [ "$count_after" -gt "$count_before" ] && MIGRATIONS_APPLIED=true
    else
      log "warning: could not read the applied-migration count — assuming migrations were applied"
      MIGRATIONS_APPLIED=true
    fi
  fi
  write_update_env "$PREV" "$NEW" "$DUMP" "$MIGRATIONS_APPLIED"

  [ "$up_ok" = 1 ] || deploy_failed "'deploy/dc.sh up -d' failed (migrate or a container did not start)"
  wait_healthy || deploy_failed "api + web did not become healthy within ${HEALTH_TIMEOUT}s"
  smoke || deploy_failed "the smoke check failed"

  local repo2
  for repo2 in devdigest-api devdigest-web; do
    run docker image tag "$repo2:$NEW12" "$repo2:local" || log "warning: could not tag $repo2:local"
  done
  prune_images "$NEW12" "$PREV12" local
  log "$PREV12 → $NEW12"
  log "smoke: ok"
  exit 0
}

do_rollback() {
  [ -f "$UPDATE_ENV" ] || die "no previous update recorded ($UPDATE_ENV) — nothing to roll back to"
  local prev dump head entries count
  prev=$(state_key previous_sha)
  dump=$(state_key pre_update_dump)
  [[ $prev =~ ^[0-9a-f]{40}$ ]] || die "previous_sha in $UPDATE_ENV is missing or invalid"
  git_ cat-file -e "$prev^{commit}" 2>/dev/null || die "the previous commit ${prev:0:12} is not in this checkout"
  head=$(git_ rev-parse HEAD)

  entries=$(git_ show "$prev:$JOURNAL_PATH" 2>/dev/null | grep -c '"tag"' || true)
  [[ $entries =~ ^[0-9]+$ ]] || entries=0
  count=$(db_migration_count) || die "could not read the applied-migration count through the backup role — refusing to roll back blind"
  if [ "$count" -gt "$entries" ]; then
    log "ERROR: the database has $count applied migrations, but ${prev:0:12} knows only $entries."
    log "Rolling back the code alone is unsafe. Restore the pre-update dump ${dump:-<unknown>} instead"
    log "(docs/deployment.md, \"Backup & restore\"):"
    print_restore_commands "$prev" "${dump:-<pre-update dump>}"
    exit 1
  fi

  log "rolling back ${head:0:12} → ${prev:0:12}"
  run git_ reset --hard "$prev" || die "git reset --hard ${prev:0:12} failed"
  if ! redeploy "$prev"; then
    die "rolled back to ${prev:0:12}, but it is not healthy — check 'deploy/dc.sh ps' and 'deploy/dc.sh logs'" 2
  fi
  smoke || die "rolled back to ${prev:0:12}, but the smoke check failed" 2
  write_update_env "$head" "$prev" "$dump" false
  log "rolled back to ${prev:0:12} (from ${head:0:12})"
  log "smoke: ok"
  exit 0
}

preflight
case "$MODE" in
  update) do_update ;;
  rollback) do_rollback ;;
esac
