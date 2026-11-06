#!/usr/bin/env bash
#
# Post-deploy smoke check (spec US-6, AC-50..AC-57). Credential-free: no
# cookies are sent or stored, TLS is never bypassed.
#
#   bash deploy/smoke.sh <bare-host>          # e.g. devdigest.example.com
#   SMOKE_RESOLVE_IP=127.0.0.1 bash deploy/smoke.sh devdigest.example.com
#
# SMOKE_RESOLVE_IP (optional): pin <host> to this IP for every request via
# `curl --resolve` (works around hairpin NAT when run on the VM itself). The
# URL host stays <host>, so SNI and certificate validation are unchanged.
#
# Checks, in order: http-redirect, tls-hsts, ready, auth-barrier,
# google-redirect, web-html. One `ok|FAIL <check> [hint]` line per check on
# stdout; a one-line summary on stderr.
#
# Exit: 0 every check ok · 1 at least one check FAILed · 2 usage / host
# validation / DNS error (no check was run).
#
# Bash 3.2 compatible (macOS). Response content is only compared against fixed
# strings, never evaluated.

set -u

readonly CHECKS="http-redirect tls-hsts ready auth-barrier google-redirect web-html"
readonly TOTAL_BUDGET_S=60
readonly REQUEST_MAX_S=10
readonly CONNECT_MAX_S=5
readonly RESOLVE_MAX_S=10
readonly HSTS_MIN_MAX_AGE=31536000
readonly MAX_BODY_BYTES=65536
readonly PROXY_HINT='check TRUST_PROXY = proxy IP and that the request reached the API over HTTPS via Caddy'

usage() {
  {
    echo "usage: smoke.sh <bare-host>"
    echo "  <bare-host>: a DNS name only — no scheme, port, path, credentials or spaces"
    echo "  env SMOKE_RESOLVE_IP=<ip>: send every request to <ip> (curl --resolve)"
  } >&2
}

die_usage() {
  echo "smoke: $1" >&2
  usage
  exit 2
}

# ---- argument validation (AC-57) ---------------------------------------------

if [ "$#" -eq 1 ] && { [ "$1" = "-h" ] || [ "$1" = "--help" ]; }; then
  usage
  exit 0
fi
[ "$#" -eq 1 ] || die_usage "expected exactly one argument, got $#"

HOST=$1
case "$HOST" in
  "") die_usage "host is empty" ;;
  *://*) die_usage "host must not contain a scheme: '$HOST'" ;;
  *@*) die_usage "host must not contain credentials: '$HOST'" ;;
  */*) die_usage "host must not contain a path: '$HOST'" ;;
  *:*) die_usage "host must not contain a port: '$HOST'" ;;
  *[[:space:]]*) die_usage "host must not contain spaces" ;;
esac
# A DNS name: dot-separated labels of [A-Za-z0-9-], not starting/ending with '-'.
if ! printf '%s' "$HOST" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$' \
  || [ "${#HOST}" -gt 253 ]; then
  die_usage "host is not a valid DNS name: '$HOST'"
fi
HOST=${HOST%.}

# ---- resolution (AC-57: non-zero within 15 s when it does not resolve) -------

# Run "$@" with a hard wall-clock limit (no coreutils `timeout` on macOS).
run_limited() {
  local limit=$1; shift
  "$@" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge $((limit * 10)) ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$pid"
}

resolves() {
  local h=$1 out
  if command -v getent >/dev/null 2>&1 && [ "$(type -t getent)" = "file" ]; then
    run_limited "$RESOLVE_MAX_S" getent hosts "$h" >/dev/null 2>&1
    return $?
  elif command -v host >/dev/null 2>&1; then
    out=$(run_limited "$RESOLVE_MAX_S" host -W 5 "$h" 2>/dev/null) || return 1
    printf '%s\n' "$out" | grep -Eq 'has (IPv6 )?address'
    return $?
  elif command -v dig >/dev/null 2>&1; then
    out=$(run_limited "$RESOLVE_MAX_S" dig +short +time=5 +tries=1 "$h" A "$h" AAAA 2>/dev/null) || return 1
    printf '%s\n' "$out" | grep -Eq '^[0-9a-fA-F.:]+$'
    return $?
  fi
  return 0 # no resolver tool: curl reports exit 6 per check instead
}

RESOLVE_IP=${SMOKE_RESOLVE_IP:-}
RESOLVE_ARGS=()
if [ -n "$RESOLVE_IP" ]; then
  if printf '%s' "$RESOLVE_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    RESOLVE_ARGS=(--resolve "$HOST:80:$RESOLVE_IP" --resolve "$HOST:443:$RESOLVE_IP")
  elif printf '%s' "$RESOLVE_IP" | grep -Eq '^[0-9A-Fa-f:]+$' && case "$RESOLVE_IP" in *:*) true ;; *) false ;; esac; then
    RESOLVE_ARGS=(--resolve "$HOST:80:[$RESOLVE_IP]" --resolve "$HOST:443:[$RESOLVE_IP]")
  else
    die_usage "SMOKE_RESOLVE_IP is not an IP address: '$RESOLVE_IP'"
  fi
elif ! resolves "$HOST"; then
  echo "FAIL resolve host '$HOST' does not resolve (DNS) — check the A/AAAA record"
  echo "smoke: FAIL (DNS)" >&2
  exit 2
fi

# ---- request helper -----------------------------------------------------------

WORK=$(mktemp -d "${TMPDIR:-/tmp}/devdigest-smoke.XXXXXX") || { echo "smoke: mktemp failed" >&2; exit 2; }
trap 'rm -rf "$WORK"' EXIT
HDRS="$WORK/headers"
BODY="$WORK/body"

STATUS=""   # HTTP status of the last request
CURL_RC=0   # curl exit code of the last request

# fetch <url> — fills $HDRS, $BODY, $STATUS, $CURL_RC. Never follows redirects.
fetch() {
  local url=$1 remaining max
  remaining=$((TOTAL_BUDGET_S - SECONDS))
  max=$REQUEST_MAX_S
  [ "$remaining" -lt "$max" ] && max=$remaining
  [ "$max" -lt 1 ] && max=1
  : >"$HDRS"; : >"$BODY"
  # -q MUST be first: ignore ~/.curlrc (it could inject -k or a cookie jar).
  STATUS=$(curl -q --silent --show-error \
    --max-time "$max" --connect-timeout "$CONNECT_MAX_S" \
    --proto '=http,https' --no-location --max-filesize "$MAX_BODY_BYTES" \
    ${RESOLVE_ARGS[@]+"${RESOLVE_ARGS[@]}"} \
    -o "$BODY" -D "$HDRS" -w '%{http_code}' \
    "$url" 2>"$WORK/stderr")
  CURL_RC=$?
}

# header <name> — value of the first matching response header (case-insensitive, CR stripped).
header() {
  tr -d '\r' <"$HDRS" | awk -v want="$(printf '%s' "$1" | tr 'A-Z' 'a-z')" '
    { i = index($0, ":"); if (i == 0) next
      name = tolower(substr($0, 1, i - 1))
      if (name == want) { v = substr($0, i + 1); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); print v; exit } }'
}

curl_hint() {
  case "$CURL_RC" in
    6) echo "DNS: could not resolve host (curl exit 6)" ;;
    7) echo "connection refused (curl exit 7) — is the proxy up and the port open?" ;;
    28) echo "timed out (curl exit 28)" ;;
    35) echo "TLS handshake failed (curl exit 35) — certificate not issued yet or wrong host?" ;;
    51|60) echo "certificate not valid for '$HOST' (curl exit $CURL_RC) — staging/self-signed cert or DNS not pointing here?" ;;
    63) echo "response body too large (curl exit 63)" ;;
    *) echo "request failed (curl exit $CURL_RC)" ;;
  esac
}

# ---- checks -------------------------------------------------------------------
# Each check_<name> echoes nothing on success, or a hint and returns 1.

check_http_redirect() {
  fetch "http://$HOST/"
  [ "$CURL_RC" -eq 0 ] || { curl_hint; return 1; }
  case "$STATUS" in 301|308) ;; *) echo "expected 301/308 permanent redirect, got $STATUS"; return 1 ;; esac
  local loc; loc=$(header location)
  [ "$loc" = "https://$HOST/" ] || { echo "expected Location https://$HOST/, got '${loc}'"; return 1; }
}

check_tls_hsts() {
  fetch "https://$HOST/"
  [ "$CURL_RC" -eq 0 ] || { curl_hint; return 1; }
  local hsts age
  hsts=$(header strict-transport-security)
  [ -n "$hsts" ] || { echo "no Strict-Transport-Security header"; return 1; }
  age=$(printf '%s' "$hsts" | tr 'A-Z' 'a-z' | sed -n 's/.*max-age="\{0,1\}\([0-9][0-9]*\).*/\1/p')
  [ -n "$age" ] || { echo "Strict-Transport-Security has no max-age"; return 1; }
  # Compare as strings of digits first to avoid integer overflow on absurd values.
  if [ "${#age}" -lt "${#HSTS_MIN_MAX_AGE}" ] || { [ "${#age}" -eq "${#HSTS_MIN_MAX_AGE}" ] && [ "$age" -lt "$HSTS_MIN_MAX_AGE" ]; }; then
    echo "HSTS max-age=$age < $HSTS_MIN_MAX_AGE"; return 1
  fi
}

check_ready() {
  fetch "https://$HOST/api/health/ready"
  [ "$CURL_RC" -eq 0 ] || { curl_hint; return 1; }
  [ "$STATUS" = "200" ] || { echo "expected 200, got $STATUS — API not ready (database reachable?)"; return 1; }
  grep -Fq '"ready":true' "$BODY" || { echo 'body does not contain "ready":true'; return 1; }
}

check_auth_barrier() {
  fetch "https://$HOST/api/repos"
  [ "$CURL_RC" -eq 0 ] || { curl_hint; return 1; }
  [ "$STATUS" = "401" ] || { echo "expected 401 for an unauthenticated request, got $STATUS"; return 1; }
}

check_google_redirect() {
  fetch "https://$HOST/api/auth/google/start"
  [ "$CURL_RC" -eq 0 ] || { curl_hint; return 1; }
  local loc; loc=$(header location)
  case "$STATUS" in 302|303|307) ;; *) echo "expected 302/303/307 redirect, got $STATUS"; return 1 ;; esac
  case "$loc" in
    https://accounts.google.com/*|https://accounts.google.com\?*|https://accounts.google.com) return 0 ;;
  esac
  case "$loc" in
    */sign-in*) echo "redirected to the sign-in error page — $PROXY_HINT" ;;
    *) echo "expected Location host accounts.google.com, got '${loc}'" ;;
  esac
  return 1
}

check_web_html() {
  fetch "https://$HOST/"
  [ "$CURL_RC" -eq 0 ] || { curl_hint; return 1; }
  [ "$STATUS" = "200" ] || { echo "expected 200 from the web app, got $STATUS"; return 1; }
  local ct; ct=$(header content-type | tr 'A-Z' 'a-z')
  case "$ct" in text/html*) ;; *) echo "expected content-type text/html, got '${ct}'"; return 1 ;; esac
}

failed=0
for check in $CHECKS; do
  if [ "$SECONDS" -ge "$TOTAL_BUDGET_S" ]; then
    echo "FAIL $check total time budget of ${TOTAL_BUDGET_S}s exceeded"
    failed=$((failed + 1))
    continue
  fi
  fn="check_$(printf '%s' "$check" | tr '-' '_')"
  if hint=$("$fn"); then
    echo "ok $check"
  else
    echo "FAIL $check $hint"
    failed=$((failed + 1))
  fi
done

if [ "$failed" -eq 0 ]; then
  echo "smoke: ok" >&2
  exit 0
fi
echo "smoke: FAIL ($failed of 6 checks failed)" >&2
exit 1
