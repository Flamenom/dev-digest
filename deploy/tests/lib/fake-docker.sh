#!/usr/bin/env bash
# Fake `docker` for deploy/tests/update.test.sh — never talks to a daemon.
# Install it on PATH as `docker`. All state lives in $FAKE_DOCKER_STATE:
#   calls.log            one line per call: "<DEVDIGEST_IMAGE_TAG or -> <args…>"
#   images               one "<repo>:<tag>" per line (image inspect / tag / ls / rm)
#   journal_count        applied-migration count returned by `psql` (default 0)
#   migrate_adds         if present, `up` adds this many to journal_count (once)
#   up_count             number of `compose up` calls so far
#   health               default health of api + web in `compose ps` (healthy)
#   health_after_up_<n>  health after the n-th `up` (overrides `health`)
#   fail_dump | fail_build | fail_up | no_psql   force that call to fail
set -uo pipefail
S="${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE is not set}"
touch "$S/images" "$S/calls.log"
printf '%s %s\n' "${DEVDIGEST_IMAGE_TAG:--}" "$*" >> "$S/calls.log"

has_image() { grep -qxF "$1" "$S/images"; }
add_image() { has_image "$1" || printf '%s\n' "$1" >> "$S/images"; }

case "${1:-}" in
  image)
    case "${2:-}" in
      inspect) has_image "$3" && { echo '[{}]'; exit 0; }; echo "Error: No such image: $3" >&2; exit 1 ;;
      tag) has_image "$3" || { echo "Error: No such image: $3" >&2; exit 1; }; add_image "$4"; exit 0 ;;
      ls) repo="${!#}"; grep "^$repo:" "$S/images" | sed "s|^$repo:||"; exit 0 ;;
      rm) grep -vxF "$3" "$S/images" > "$S/images.tmp" || true; mv "$S/images.tmp" "$S/images"; echo "Untagged: $3"; exit 0 ;;
      prune) echo "Total reclaimed space: 0B"; exit 0 ;;
    esac ;;
  builder)
    if [ "${3:-}" = "--help" ]; then echo "  --keep-storage bytes   Amount of disk space to keep for cache"; exit 0; fi
    echo "Total: 0B"; exit 0 ;;
  compose)
    shift
    [ "${1:-}" = "-f" ] && shift 2
    sub="${1:-}"; shift || true
    case "$sub" in
      run)
        case " $* " in
          *" dump pre-update "*)
            [ -f "$S/fail_dump" ] && { echo "pg_dump: error: connection refused" >&2; exit 1; }
            sha="${!#}"
            echo "dumping…"
            echo "dump: devdigest-20261106T031500Z-pre-update-$sha.dump"
            exit 0 ;;
          *" psql "*)
            [ -f "$S/no_psql" ] && exit 1
            cat "$S/journal_count" 2>/dev/null || echo 0; exit 0 ;;
        esac
        exit 0 ;;
      exec)
        # Pretend the long-lived backup container is not running: forces `run` fallback.
        exit 1 ;;
      build)
        [ -f "$S/fail_build" ] && { echo "ERROR: failed to solve: build error" >&2; exit 1; }
        tag="${DEVDIGEST_IMAGE_TAG:-local}"
        add_image "devdigest-api:$tag"; add_image "devdigest-web:$tag"
        echo "built $tag"; exit 0 ;;
      up)
        n=$(( $(cat "$S/up_count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/up_count"
        if [ -f "$S/migrate_adds" ]; then
          c=$(cat "$S/journal_count" 2>/dev/null || echo 0)
          echo $(( c + $(cat "$S/migrate_adds") )) > "$S/journal_count"; rm -f "$S/migrate_adds"
        fi
        [ -f "$S/fail_up" ] && { echo "service migrate didn't complete successfully" >&2; exit 1; }
        exit 0 ;;
      ps)
        n=$(cat "$S/up_count" 2>/dev/null || echo 0)
        h=$(cat "$S/health_after_up_$n" 2>/dev/null || cat "$S/health" 2>/dev/null || echo healthy)
        printf '{"Service":"api","State":"running","Health":"%s"}\n' "$h"
        printf '{"Service":"web","State":"running","Health":"%s"}\n' "$h"
        printf '{"Service":"postgres","State":"running","Health":"healthy"}\n'
        exit 0 ;;
      stop|down|logs) exit 0 ;;
    esac
    exit 0 ;;
esac
echo "fake docker: unhandled: $*" >&2
exit 0
