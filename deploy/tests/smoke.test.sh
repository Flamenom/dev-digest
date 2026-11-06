#!/usr/bin/env bash
#
# Hermetic tests for deploy/smoke.sh (spec AC-50..AC-57). No network: a fake
# `curl` and a fake `getent` are put first on PATH. The fake curl answers from
# FAKE_<KEY>_{STATUS,HEADERS,BODY,EXIT} env vars (healthy defaults) and records
# any forbidden flag (-k/--insecure/-b/-c/--cookie/--cookie-jar).
#
#   bash deploy/tests/smoke.test.sh
#
# Bash 3.2 compatible (macOS).

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SMOKE="$HERE/../smoke.sh"
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/smoke-test.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT
FAKEBIN="$SCRATCH/bin"
mkdir -p "$FAKEBIN"
export FAKE_CURL_LOG="$SCRATCH/curl.log"
export FAKE_CURL_FORBIDDEN="$SCRATCH/forbidden"

# ---- fake curl ----------------------------------------------------------------
cat >"$FAKEBIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"$FAKE_CURL_LOG"
out="" hdr="" wfmt="" url="" first=1
while [ "$#" -gt 0 ]; do
  a=$1
  if [ "$first" -eq 1 ] && [ "$a" != "-q" ]; then echo "first arg not -q: $a" >>"$FAKE_CURL_FORBIDDEN"; fi
  first=0
  case "$a" in
    -k|--insecure|-b|--cookie|-c|--cookie-jar|-L|--location|--netrc|-n|-u|--user)
      echo "forbidden flag: $a" >>"$FAKE_CURL_FORBIDDEN" ;;
    --*) ;;
    -?*) case "$a" in *[kbc]*) echo "forbidden short flag: $a" >>"$FAKE_CURL_FORBIDDEN" ;; esac ;;
  esac
  case "$a" in
    -o) out=$2; shift ;;
    -D) hdr=$2; shift ;;
    -w) wfmt=$2; shift ;;
    --max-time|--connect-timeout|--proto|--max-filesize|--resolve) shift ;;
    -*) ;;
    *) url=$a ;;
  esac
  shift
done
case "$url" in
  http://*/) key=HTTP_ROOT ;;
  https://*/api/health/ready) key=READY ;;
  https://*/api/repos) key=REPOS ;;
  https://*/api/auth/google/start) key=GOOGLE ;;
  https://*/) key=HTTPS_ROOT ;;
  *) echo "unexpected url: $url" >>"$FAKE_CURL_FORBIDDEN"; exit 3 ;;
esac
host=${url#*://}; host=${host%%/*}
case "$key" in
  HTTP_ROOT)  d_status=308; d_headers="Location: https://$host/"; d_body="" ;;
  HTTPS_ROOT) d_status=200; d_headers="Content-Type: text/html; charset=utf-8
Strict-Transport-Security: max-age=31536000; includeSubDomains"; d_body="<!DOCTYPE html><html></html>" ;;
  READY)      d_status=200; d_headers="content-type: application/json"; d_body='{"ready":true}' ;;
  REPOS)      d_status=401; d_headers="content-type: application/json"; d_body='{"error":{"code":"unauthorized"}}' ;;
  GOOGLE)     d_status=302; d_headers="location: https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y"; d_body="" ;;
esac
eval "status=\${FAKE_${key}_STATUS:-\$d_status}"
eval "headers=\${FAKE_${key}_HEADERS-\$d_headers}"
eval "body=\${FAKE_${key}_BODY-\$d_body}"
eval "rc=\${FAKE_${key}_EXIT:-0}"
if [ "$rc" -ne 0 ]; then
  echo "curl: ($rc) fake failure" >&2
  [ -n "$wfmt" ] && printf '000'
  exit "$rc"
fi
if [ -n "$hdr" ]; then
  { printf 'HTTP/1.1 %s X\r\n' "$status"
    [ -n "$headers" ] && printf '%s\n' "$headers" | sed 's/$/\r/'
    printf '\r\n'; } >"$hdr"
fi
[ -n "$out" ] && printf '%s' "$body" >"$out"
[ -n "$wfmt" ] && printf '%s' "${wfmt//%\{http_code\}/$status}"
exit 0
FAKE

# ---- fake getent (DNS) --------------------------------------------------------
cat >"$FAKEBIN/getent" <<'FAKE'
#!/usr/bin/env bash
[ -n "${FAKE_GETENT_SLEEP:-}" ] && sleep "$FAKE_GETENT_SLEEP"
case "$2" in
  *.invalid) exit 2 ;;
  *) echo "203.0.113.10    $2"; exit 0 ;;
esac
FAKE
chmod +x "$FAKEBIN/curl" "$FAKEBIN/getent"

# ---- harness ------------------------------------------------------------------
pass=0 fail=0
OUT="" RC=0

run_smoke() { # env assignments are passed as leading `env` args
  OUT=$(env PATH="$FAKEBIN:$PATH" "$@" bash "$SMOKE" "${HOST_ARG-smoke.example.com}" 2>&1)
  RC=$?
}

ok()   { pass=$((pass + 1)); echo "  ok   $1"; }
bad()  { fail=$((fail + 1)); echo "  FAIL $1"; printf '%s\n' "$OUT" | sed 's/^/       | /'; }
expect() { # name, condition-result
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi
}
has() { printf '%s\n' "$OUT" | grep -Eq -- "$1"; }

echo "smoke.test.sh"

# 1. all ok
HOST_ARG=smoke.example.com run_smoke
n_ok=$(printf '%s\n' "$OUT" | grep -c '^ok ')
[ "$RC" -eq 0 ] && [ "$n_ok" -eq 6 ] && ! has '^FAIL' \
  && has '^ok http-redirect$' && has '^ok tls-hsts$' && has '^ok ready$' \
  && has '^ok auth-barrier$' && has '^ok google-redirect$' && has '^ok web-html$'
expect "all healthy → exit 0, 6 ok lines in order" $?
order=$(printf '%s\n' "$OUT" | awk '/^ok /{printf "%s ", $2}')
[ "$order" = "http-redirect tls-hsts ready auth-barrier google-redirect web-html " ]
expect "checks run in the contract order" $?

# 1b. SMOKE_RESOLVE_IP adds --resolve pairs for 80 and 443
: >"$FAKE_CURL_LOG"
run_smoke SMOKE_RESOLVE_IP=127.0.0.1
[ "$RC" -eq 0 ] && grep -q -- '--resolve smoke.example.com:80:127.0.0.1 --resolve smoke.example.com:443:127.0.0.1' "$FAKE_CURL_LOG" \
  && [ "$(grep -c -- '--resolve' "$FAKE_CURL_LOG")" -eq 6 ]
expect "SMOKE_RESOLVE_IP → every request pinned with --resolve (80+443)" $?
run_smoke SMOKE_RESOLVE_IP=::1
[ "$RC" -eq 0 ] && grep -q -- 'smoke.example.com:443:\[::1\]' "$FAKE_CURL_LOG"
expect "SMOKE_RESOLVE_IP IPv6 → bracketed --resolve" $?
run_smoke SMOKE_RESOLVE_IP='1.2.3.4;rm'
[ "$RC" -ne 0 ] && has 'SMOKE_RESOLVE_IP is not an IP'
expect "SMOKE_RESOLVE_IP non-IP → rejected" $?
: >"$FAKE_CURL_LOG"
HOST_ARG=nx.invalid run_smoke SMOKE_RESOLVE_IP=127.0.0.1
[ "$RC" -eq 0 ]
expect "SMOKE_RESOLVE_IP set → DNS lookup skipped" $?

# 2. http answers 200 instead of redirecting
run_smoke FAKE_HTTP_ROOT_STATUS=200 FAKE_HTTP_ROOT_HEADERS=
[ "$RC" -ne 0 ] && has '^FAIL http-redirect expected 301/308' && [ "$(printf '%s\n' "$OUT" | grep -c '^ok ')" -eq 5 ]
expect "http 200 → FAIL http-redirect only" $?
run_smoke 'FAKE_HTTP_ROOT_HEADERS=Location: https://evil.example/'
[ "$RC" -ne 0 ] && has '^FAIL http-redirect expected Location'
expect "redirect to another host → FAIL http-redirect" $?
run_smoke FAKE_HTTP_ROOT_STATUS=302
[ "$RC" -ne 0 ] && has '^FAIL http-redirect'
expect "temporary 302 redirect → FAIL http-redirect" $?
run_smoke FAKE_HTTP_ROOT_STATUS=301
[ "$RC" -eq 0 ]
expect "301 accepted as permanent" $?

# 3. certificate error (curl exit 60)
run_smoke FAKE_HTTPS_ROOT_EXIT=60
[ "$RC" -ne 0 ] && has '^FAIL tls-hsts certificate not valid'
expect "cert error exit 60 → FAIL tls-hsts with cert hint" $?
run_smoke FAKE_HTTPS_ROOT_EXIT=35
[ "$RC" -ne 0 ] && has '^FAIL tls-hsts TLS handshake failed'
expect "TLS handshake exit 35 → FAIL tls-hsts" $?

# 4. weak / missing HSTS
run_smoke 'FAKE_HTTPS_ROOT_HEADERS=Content-Type: text/html
Strict-Transport-Security: max-age=300'
[ "$RC" -ne 0 ] && has '^FAIL tls-hsts HSTS max-age=300' && has '^ok web-html$'
expect "max-age=300 → FAIL tls-hsts" $?
run_smoke 'FAKE_HTTPS_ROOT_HEADERS=Content-Type: text/html'
[ "$RC" -ne 0 ] && has '^FAIL tls-hsts no Strict-Transport-Security'
expect "no HSTS header → FAIL tls-hsts" $?
run_smoke 'FAKE_HTTPS_ROOT_HEADERS=content-type: text/html
strict-transport-security: max-age=63072000; preload'
[ "$RC" -eq 0 ]
expect "lower-case headers, max-age=63072000 → ok" $?

# 5. not ready
run_smoke FAKE_READY_STATUS=503 'FAKE_READY_BODY={"ready":false}'
[ "$RC" -ne 0 ] && has '^FAIL ready expected 200, got 503'
expect "ready 503 → FAIL ready" $?
run_smoke 'FAKE_READY_BODY={"ready":false}'
[ "$RC" -ne 0 ] && has '^FAIL ready body does not contain'
expect "ready 200 without ready:true → FAIL ready" $?

# 6. auth barrier off
run_smoke FAKE_REPOS_STATUS=200
[ "$RC" -ne 0 ] && has '^FAIL auth-barrier expected 401'
expect "repos 200 → FAIL auth-barrier" $?

# 7. google start lands on the sign-in error page (identity/helpers.ts signInErrorLocation)
run_smoke 'FAKE_GOOGLE_HEADERS=location: https://smoke.example.com/sign-in?error=auth_state_invalid'
[ "$RC" -ne 0 ] && has '^FAIL google-redirect .*check TRUST_PROXY = proxy IP and that the request reached the API over HTTPS via Caddy'
expect "google start → /sign-in?error=… → FAIL with TRUST_PROXY hint" $?
run_smoke 'FAKE_GOOGLE_HEADERS=location: https://accounts.google.com.evil.example/x'
[ "$RC" -ne 0 ] && has '^FAIL google-redirect expected Location host accounts.google.com'
expect "look-alike google host → FAIL google-redirect" $?
run_smoke FAKE_GOOGLE_STATUS=404 FAKE_GOOGLE_HEADERS=
[ "$RC" -ne 0 ] && has '^FAIL google-redirect expected 302/303/307'
expect "google start 404 → FAIL google-redirect" $?

# 8. web down
run_smoke FAKE_HTTPS_ROOT_STATUS=502
[ "$RC" -ne 0 ] && has '^FAIL web-html expected 200 from the web app, got 502'
expect "web 502 → FAIL web-html" $?
run_smoke 'FAKE_HTTPS_ROOT_HEADERS=Content-Type: application/json
Strict-Transport-Security: max-age=31536000'
[ "$RC" -ne 0 ] && has '^FAIL web-html expected content-type text/html'
expect "web non-HTML → FAIL web-html" $?

# 9. host argument validation (AC-57)
for bad_host in 'https://x' 'x:443' 'x/p' 'u@x' 'a b' '' '-x' 'x..y'; do
  start=$SECONDS
  HOST_ARG=$bad_host run_smoke
  [ "$RC" -ne 0 ] && has 'usage' && [ $((SECONDS - start)) -lt 2 ]
  expect "host '$bad_host' → usage error, non-zero, fast" $?
done
OUT=$(env PATH="$FAKEBIN:$PATH" bash "$SMOKE" 2>&1); RC=$?
[ "$RC" -ne 0 ] && has 'usage'
expect "no argument → usage error" $?
OUT=$(env PATH="$FAKEBIN:$PATH" bash "$SMOKE" a.example b.example 2>&1); RC=$?
[ "$RC" -ne 0 ] && has 'usage'
expect "two arguments → usage error" $?

# 10. unresolvable host → DNS error fast; hung resolver bounded (< 15 s)
: >"$FAKE_CURL_LOG"
start=$SECONDS
HOST_ARG=nx.invalid run_smoke
[ "$RC" -ne 0 ] && has 'does not resolve \(DNS\)' && [ $((SECONDS - start)) -lt 15 ] && [ ! -s "$FAKE_CURL_LOG" ]
expect "unresolvable host → DNS error, no requests, < 15 s" $?
start=$SECONDS
HOST_ARG=slow.invalid run_smoke FAKE_GETENT_SLEEP=30
elapsed=$((SECONDS - start))
[ "$RC" -ne 0 ] && has 'does not resolve' && [ "$elapsed" -lt 15 ]
expect "hung resolver → DNS error in ${elapsed}s (< 15 s)" $?

# 11. no insecure / cookie flags were ever passed, -q always first
if [ -s "$FAKE_CURL_FORBIDDEN" ]; then
  OUT=$(cat "$FAKE_CURL_FORBIDDEN"); false
else
  true
fi
expect "fake curl never received -k/--insecure/-b/-c (and -q was first)" $?

echo "smoke.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
