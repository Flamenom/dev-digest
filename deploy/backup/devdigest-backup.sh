#!/bin/sh
# DevDigest backup service — POSIX sh (runs in the pgvector/pgvector:*-pg16 image,
# no bash guarantee). Mounted read-only at /opt/devdigest/backup/ by the `backup`
# service in deploy/compose.yml; dumps land in /backups (host: BACKUP_DIR).
#
# Usage:
#   devdigest-backup.sh daemon                    nightly loop at BACKUP_SCHEDULE (HH:MM UTC)
#   devdigest-backup.sh dump nightly              one nightly dump + nightly rotation
#   devdigest-backup.sh dump pre-update <sha7>    one pre-update dump + pre-update rotation
#   devdigest-backup.sh health                    exit 0 if a nightly dump is < 26 h old,
#                                                 or the first start is < 26 h ago
#
# Connection: libpq PG* env (PGHOST, PGPORT, PGDATABASE, PGUSER = devdigest_backup,
# the read-only role created by deploy/db-grants/backup-role.sql). The password
# comes from BACKUP_DB_PASSWORD, is written once to a 0600 passfile on the tmpfs
# and then unset: it is never an argument of any process, never logged, never part
# of a file name.
#
# Dump: `pg_dump -Fc` to /backups/.tmp-<final> (umask 077), verified with
# `pg_restore --list`, then renamed. Any failure removes the temp file, keeps every
# earlier dump, skips rotation and exits 1. Rotation keeps the newest
# BACKUP_RETAIN nightly / BACKUP_RETAIN_PRE_UPDATE pre-update dumps, per kind.
#
# Log lines (stderr): `backup: <event> <filename|reason>` — never an env value.
# The last stdout line of a successful dump is `dump: <final-filename>`.

set -u
umask 077

DIR=/backups
PASSFILE=/tmp/.pgpass
DEFAULT_SCHEDULE=03:15
DEFAULT_RETAIN=14
DEFAULT_RETAIN_PRE_UPDATE=5
# 26 h, in minutes (AC-28): health window and first-start grace period.
HEALTH_WINDOW_MIN=1560
# A temp file older than 24 h belongs to a dead run, never to a live one.
STALE_TMP_MIN=1440

log() {
  printf 'backup: %s\n' "$*" >&2
}

usage() {
  sed -n '6,11p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# $1 setting name, $2 value, $3 default → prints a positive integer.
positive_int() {
  case "$2" in
    '' | *[!0-9]*)
      log "invalid-setting $1 (using default $3)"
      echo "$3"
      return
      ;;
  esac
  # Strip leading zeros so the shell never reads the value as octal.
  v=$(printf '%s' "$2" | sed 's/^0*//')
  if [ -z "$v" ] || [ "${#v}" -gt 6 ]; then
    log "invalid-setting $1 (using default $3)"
    echo "$3"
    return
  fi
  echo "$v"
}

RETAIN=$(positive_int BACKUP_RETAIN "${BACKUP_RETAIN:-$DEFAULT_RETAIN}" "$DEFAULT_RETAIN")
RETAIN_PRE_UPDATE=$(positive_int BACKUP_RETAIN_PRE_UPDATE \
  "${BACKUP_RETAIN_PRE_UPDATE:-$DEFAULT_RETAIN_PRE_UPDATE}" "$DEFAULT_RETAIN_PRE_UPDATE")

SCHEDULE=${BACKUP_SCHEDULE:-$DEFAULT_SCHEDULE}
case "$SCHEDULE" in
  [0-2][0-9]:[0-5][0-9])
    case "$SCHEDULE" in
      2[4-9]:*)
        log "invalid-setting BACKUP_SCHEDULE (using default $DEFAULT_SCHEDULE)"
        SCHEDULE=$DEFAULT_SCHEDULE
        ;;
    esac
    ;;
  *)
    log "invalid-setting BACKUP_SCHEDULE (using default $DEFAULT_SCHEDULE)"
    SCHEDULE=$DEFAULT_SCHEDULE
    ;;
esac

# Write the libpq passfile from BACKUP_DB_PASSWORD, then drop the variable from
# this shell (children never inherit it). printf is a shell builtin: the value is
# never an argv entry. Returns 1 when no usable password exists.
setup_passfile() {
  pw=${BACKUP_DB_PASSWORD:-}
  unset BACKUP_DB_PASSWORD
  if [ -z "$pw" ]; then
    if [ -s "$PASSFILE" ]; then
      PGPASSFILE=$PASSFILE
      export PGPASSFILE
      return 0
    fi
    log "config-error BACKUP_DB_PASSWORD is missing"
    return 1
  fi
  # The charset rule (same as migrate's) also means no passfile escaping is needed.
  case "$pw" in
    *[!A-Za-z0-9_-]*)
      pw=
      log "config-error BACKUP_DB_PASSWORD has characters outside [A-Za-z0-9_-]"
      return 1
      ;;
  esac
  tmp="$PASSFILE.$$"
  if ! printf '*:*:*:*:%s\n' "$pw" >"$tmp" || ! chmod 600 "$tmp" || ! mv -f "$tmp" "$PASSFILE"; then
    pw=
    rm -f "$tmp"
    log "config-error cannot write the passfile"
    return 1
  fi
  pw=
  PGPASSFILE=$PASSFILE
  export PGPASSFILE
  return 0
}

remove_stale_tmp() {
  find "$DIR" -maxdepth 1 -type f -name '.tmp-*' -mmin +"$STALE_TMP_MIN" 2>/dev/null |
    while IFS= read -r f; do
      rm -f -- "$f" && log "stale-tmp-removed $(basename "$f")"
    done
}

# $1 glob (relative to $DIR), $2 how many newest files to keep.
rotate() {
  n=0
  # shellcheck disable=SC2012 # names are ours: devdigest-<ts>-<kind>.dump
  ls -1t "$DIR"/$1 2>/dev/null | while IFS= read -r f; do
    [ -f "$f" ] || continue
    n=$((n + 1))
    if [ "$n" -gt "$2" ]; then
      rm -f -- "$f" && log "rotated $(basename "$f")"
    fi
  done
}

# $1 nightly|pre-update, $2 sha (pre-update only).
dump() {
  kind=$1
  case "$kind" in
    nightly)
      suffix=nightly
      pattern='devdigest-*-nightly.dump'
      keep=$RETAIN
      ;;
    pre-update)
      sha=${2:-}
      case "$sha" in
        '' | *[!0-9a-f]*)
          log "dump-failed invalid sha (want 7-40 lowercase hex chars)"
          return 1
          ;;
      esac
      if [ "${#sha}" -lt 7 ] || [ "${#sha}" -gt 40 ]; then
        log "dump-failed invalid sha (want 7-40 lowercase hex chars)"
        return 1
      fi
      sha7=$(printf '%s' "$sha" | cut -c1-7)
      suffix="pre-update-$sha7"
      pattern='devdigest-*-pre-update-*.dump'
      keep=$RETAIN_PRE_UPDATE
      ;;
    *)
      usage
      ;;
  esac

  setup_passfile || return 1
  if [ ! -d "$DIR" ]; then
    log "dump-failed $DIR is not a directory"
    return 1
  fi
  remove_stale_tmp

  final="devdigest-$(date -u +%Y%m%dT%H%M%SZ)-$suffix.dump"
  if [ -e "$DIR/$final" ]; then
    # Two dumps of the same kind within one second: wait for a fresh name.
    sleep 1
    final="devdigest-$(date -u +%Y%m%dT%H%M%SZ)-$suffix.dump"
  fi
  tmp="$DIR/.tmp-$final"

  log "dump-start $final"
  if ! pg_dump -Fc --no-password -f "$tmp"; then
    rm -f -- "$tmp"
    log "dump-failed $final (pg_dump failed)"
    return 1
  fi
  if ! pg_restore --list "$tmp" >/dev/null; then
    rm -f -- "$tmp"
    log "dump-failed $final (table-of-contents verification failed)"
    return 1
  fi
  if ! chmod 600 "$tmp" || ! mv -f -- "$tmp" "$DIR/$final"; then
    rm -f -- "$tmp"
    log "dump-failed $final (rename failed)"
    return 1
  fi
  log "dump-ok $final"
  rotate "$pattern" "$keep"
  echo "dump: $final"
  return 0
}

health() {
  if [ -n "$(find "$DIR" -maxdepth 1 -type f -name 'devdigest-*-nightly.dump' -mmin -"$HEALTH_WINDOW_MIN" 2>/dev/null | head -n 1)" ]; then
    exit 0
  fi
  if [ -f "$DIR/.first-start" ] &&
    [ -n "$(find "$DIR/.first-start" -mmin -"$HEALTH_WINDOW_MIN" 2>/dev/null)" ]; then
    exit 0
  fi
  exit 1
}

# Seconds from now until the next HH:MM UTC (always > 0; pure arithmetic, no GNU date).
seconds_until_next() {
  hh=${SCHEDULE%%:*}
  mm=${SCHEDULE##*:}
  hh=${hh#0}
  mm=${mm#0}
  target=$(((${hh:-0} * 3600) + (${mm:-0} * 60)))
  now=$(date -u +%s)
  sod=$((now % 86400))
  diff=$((target - sod))
  if [ "$diff" -le 0 ]; then
    diff=$((diff + 86400))
  fi
  echo "$diff"
}

daemon() {
  if [ ! -d "$DIR" ]; then
    log "config-error $DIR is not mounted"
    exit 1
  fi
  [ -e "$DIR/.first-start" ] || : >"$DIR/.first-start"
  chmod 700 "$DIR" || log "warning cannot set $DIR to mode 0700"
  # Write the passfile once (also used by `docker compose exec backup psql …`).
  setup_passfile || log "config-error dumps will fail until BACKUP_DB_PASSWORD is set"
  sleeper=
  # Kill AND reap the sleeper before exiting: an orphaned child is re-parented to
  # PID 1 (tini under compose `init: true`; never leave it to a foreign init).
  trap 'if [ -n "$sleeper" ]; then kill "$sleeper" 2>/dev/null; wait "$sleeper" 2>/dev/null; fi; log "stopped signal"; exit 0' TERM INT
  log "started schedule $SCHEDULE UTC"
  while :; do
    secs=$(seconds_until_next)
    log "next-run in ${secs}s"
    sleep "$secs" &
    sleeper=$!
    wait "$sleeper"
    sleeper=
    # A failure is already logged by dump(); the loop keeps running (AC-25).
    dump nightly || true
  done
}

case "${1:-}" in
  daemon) daemon ;;
  dump)
    shift
    [ "$#" -ge 1 ] || usage
    dump "$@"
    exit $?
    ;;
  health) health ;;
  *) usage ;;
esac
