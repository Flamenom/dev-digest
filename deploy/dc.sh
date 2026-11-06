#!/usr/bin/env bash
# deploy/dc.sh — the docker compose wrapper for the single-VM deployment.
#
#   deploy/dc.sh [compose args…]      e.g. deploy/dc.sh ps · deploy/dc.sh up -d · deploy/dc.sh logs api
#
# Use it instead of a bare `docker compose -f deploy/compose.yml …`. It:
#   1. cd's into deploy/ (so compose loads deploy/.env for interpolation);
#   2. exports DEVDIGEST_IMAGE_TAG + DEVDIGEST_RELEASE from deploy/.state/release.env
#      (written by deploy/update.sh), so compose runs the images of the deployed
#      commit and the api/web report that commit as their release. A value that is
#      already set in the caller's environment wins (update.sh uses that to build
#      the next tag before it is deployed). Without the file both fall back to the
#      compose defaults (`local` / `unknown`).
#   3. execs `docker compose -f compose.yml "$@"`.
#
# release.env is parsed key by key (never sourced) and only these two keys with
# strictly validated values are accepted. deploy/.env is never read here.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$DEPLOY_DIR"

RELEASE_ENV=".state/release.env"
if [ -f "$RELEASE_ENV" ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      DEVDIGEST_RELEASE)
        if [[ $value =~ ^[0-9a-f]{7,64}$ ]] && [ -z "${DEVDIGEST_RELEASE+x}" ]; then
          export DEVDIGEST_RELEASE="$value"
        fi
        ;;
      DEVDIGEST_IMAGE_TAG)
        if [[ $value =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] && [ -z "${DEVDIGEST_IMAGE_TAG+x}" ]; then
          export DEVDIGEST_IMAGE_TAG="$value"
        fi
        ;;
    esac
  done < "$RELEASE_ENV"
fi

exec docker compose -f compose.yml "$@"
