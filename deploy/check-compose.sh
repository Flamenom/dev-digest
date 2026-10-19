#!/usr/bin/env bash
#
# Static checks for the server-mode deployment (no containers are started).
#
#   bash deploy/check-compose.sh [env-file]     # default: deploy/.env.example
#
# Verifies: compose renders; only `proxy` publishes ports (80/443); postgres and
# api are never published and postgres is only on the internal network; api runs
# exactly one replica, depends on `migrate` completing, connects as the
# least-privilege `devdigest_app` role (never POSTGRES_USER), and trusts forwarded
# headers only from the proxy's static IP; `migrate` is a one-shot
# `pnpm db:migrate && pnpm db:bootstrap` + grants step as the owner role with a
# secret-free env; the init script + grants.sql are mounted read-only; postgres drops
# all capabilities but the entrypoint minimum; persistent volumes are mounted;
# the Caddyfile sets HSTS + nosniff/Referrer-Policy/X-Frame-Options/CSP;
# Dockerfiles use pinned base images, a non-root user and no secret ARG/ENV.
# Exit 0 = all checks pass.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$DIR/compose.yml"
ENV_FILE="${1:-$DIR/.env.example}"

command -v docker >/dev/null || { echo "FAIL: docker not found" >&2; exit 1; }
command -v node   >/dev/null || { echo "FAIL: node not found" >&2; exit 1; }

echo "▸ docker compose config (env: $(basename "$ENV_FILE"))"
docker compose -f "$COMPOSE" --env-file "$ENV_FILE" config -q
RENDERED="$(docker compose -f "$COMPOSE" --env-file "$ENV_FILE" config --format json)"

echo "▸ compose topology checks"
printf '%s' "$RENDERED" | DEPLOY_DIR="$DIR" node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const cfg = JSON.parse(raw);
  const s = cfg.services ?? {};
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); else console.log("  ok  " + msg); };

  for (const name of ["proxy", "web", "api", "migrate", "postgres"])
    check(Boolean(s[name]), `service "${name}" exists`);

  // Only the proxy publishes ports, and only 80/443.
  const published = Object.entries(s).filter(([, v]) => (v.ports ?? []).length > 0).map(([k]) => k);
  check(published.length === 1 && published[0] === "proxy", `only proxy publishes ports (got: ${published.join(",") || "none"})`);
  const proxyPorts = [...new Set((s.proxy?.ports ?? []).map((p) => String(p.published)))].sort();
  check(JSON.stringify(proxyPorts) === JSON.stringify(["443", "80"]), `proxy publishes exactly 80/443 (got: ${proxyPorts.join(",")})`);
  for (const name of ["postgres", "api", "web", "migrate"])
    check(!(s[name]?.ports?.length), `${name} has no published ports`);

  // Networks: postgres only on the internal db network.
  const nets = (svc) => Object.keys(s[svc]?.networks ?? {});
  check(JSON.stringify(nets("postgres")) === JSON.stringify(["db"]), `postgres only on network "db" (got: ${nets("postgres").join(",")})`);
  const dbNet = Object.entries(cfg.networks ?? {}).find(([k]) => k === "db")?.[1];
  check(dbNet?.internal === true, "network \"db\" is internal (no egress)");
  check(!nets("web").includes("db"), "web is not on network \"db\"");
  check(!nets("proxy").includes("db"), "proxy is not on network \"db\"");

  // Single API instance.
  check(s.api?.deploy?.replicas === 1, `api deploy.replicas = 1 (got: ${s.api?.deploy?.replicas})`);

  // Migration step before the API.
  const cmd = [].concat(s.migrate?.command ?? []).join(" ");
  check(cmd.includes("pnpm db:migrate && pnpm db:bootstrap"), `migrate runs "pnpm db:migrate && pnpm db:bootstrap" (got: ${cmd})`);
  check(cmd.includes("pnpm db:migrate && pnpm db:bootstrap && node /opt/devdigest/db-grants/apply-grants.mjs"), "migrate applies runtime-role grants after migrate + bootstrap");
  check(String(s.migrate?.restart ?? "no") === "no", "migrate is one-shot (restart: no)");
  check(s.api?.depends_on?.migrate?.condition === "service_completed_successfully", "api depends_on migrate: service_completed_successfully");
  check(s.migrate?.image && s.migrate.image === s.api?.image, "migrate uses the api image");
  // Least privilege: migrate sees only what db:migrate + db:bootstrap read.
  const menv = s.migrate?.environment ?? {};
  check(Boolean(menv.DATABASE_URL), "migrate has DATABASE_URL");
  for (const k of ["GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "SECRETS_MASTER_KEY", "SECRETS_MASTER_KEY_PREVIOUS", "AUTH_ADMIN_EMAILS"])
    check(!(k in menv), `migrate env has no ${k}`);
  check(Object.keys(menv).every((k) => !/SECRET|MASTER_KEY|TOKEN|API_KEY/.test(k)), `migrate env has no secret-like keys (got: ${Object.keys(menv).join(",")})`);
  const apiCmd = [].concat(s.api?.command ?? []).join(" ");
  check(!/db:migrate|migrate\.ts/.test(apiCmd), "api command does not migrate");

  const mounts = (svc) => (s[svc]?.volumes ?? []).map((v) => `${v.source}:${v.target}`);
  // DB roles: api uses the least-privilege runtime role, migrate the owner.
  const dbUser = (u) => { try { return decodeURIComponent(new URL(u).username); } catch { return ""; } };
  const pgUser = s.postgres?.environment?.POSTGRES_USER;
  const apiUser = dbUser(s.api?.environment?.DATABASE_URL ?? "");
  const migUser = dbUser(menv.DATABASE_URL ?? "");
  check(Boolean(pgUser), "postgres POSTGRES_USER is set");
  check(apiUser === "devdigest_app" && apiUser !== pgUser, `api DATABASE_URL user is the runtime role, not POSTGRES_USER (got: ${apiUser} vs ${pgUser})`);
  check(migUser === pgUser, `migrate DATABASE_URL user is the owner POSTGRES_USER (got: ${migUser})`);
  const pwOf = (u) => { try { return decodeURIComponent(new URL(u).password); } catch { return ""; } };
  check(pwOf(s.api?.environment?.DATABASE_URL ?? "") !== pwOf(menv.DATABASE_URL ?? ""), "api and migrate DB passwords differ");
  check(Boolean(menv.APP_DB_PASSWORD), "migrate has APP_DB_PASSWORD (creates / re-keys the runtime role)");
  check(Boolean(s.postgres?.environment?.APP_DB_PASSWORD), "postgres has APP_DB_PASSWORD (first-boot init)");
  check(!("POSTGRES_PASSWORD" in (s.api?.environment ?? {})), "api env has no POSTGRES_PASSWORD");
  check(mounts("postgres").includes(`${process.env.DEPLOY_DIR}/postgres-init:/docker-entrypoint-initdb.d`), "postgres init script dir mounted at /docker-entrypoint-initdb.d");
  check(mounts("postgres").some((m) => m.endsWith("/db-grants:/opt/devdigest/db-grants")), "postgres mounts db-grants (init applies grants.sql)");
  check(mounts("migrate").some((m) => m.endsWith("/db-grants:/opt/devdigest/db-grants")), "migrate mounts db-grants");
  for (const svc of ["postgres", "migrate"])
    check((s[svc]?.volumes ?? []).filter((v) => /db-grants|postgres-init/.test(v.source ?? "")).every((v) => v.read_only === true), `${svc} grant/init mounts are read-only`);

  // Auth mode + trusted proxy.
  const env = s.api?.environment ?? {};
  check(env.AUTH_MODE === "google", "api AUTH_MODE=google");
  check(env.NODE_ENV === "production", "api NODE_ENV=production");
  check(env.DEVDIGEST_CLONE_DIR === "/data/clones", "api DEVDIGEST_CLONE_DIR=/data/clones");
  const proxyIp = s.proxy?.networks?.edge?.ipv4_address;
  check(Boolean(proxyIp) && env.TRUST_PROXY === proxyIp, `api TRUST_PROXY equals proxy static IP (${env.TRUST_PROXY} vs ${proxyIp})`);
  check(Boolean(s.api?.healthcheck?.test?.join(" ").includes("/health/ready")), "api healthcheck hits /health/ready");
  check(s.web?.build?.args?.NEXT_PUBLIC_API_BASE === "/api", "web built with NEXT_PUBLIC_API_BASE=/api");

  // Persistence.
  check(mounts("postgres").includes("pgdata:/var/lib/postgresql/data"), "postgres data on volume pgdata");
  check(mounts("api").includes("clones:/data/clones"), "api clones on volume clones");
  check(mounts("proxy").includes("caddy_data:/data"), "caddy certificates on volume caddy_data");
  check(mounts("proxy").includes("caddy_config:/config"), "caddy config on volume caddy_config");

  // Every long-running service restarts and drops privileges.
  for (const name of ["proxy", "web", "api", "postgres"]) {
    check(s[name]?.restart === "unless-stopped", `${name} restart: unless-stopped`);
    check((s[name]?.security_opt ?? []).includes("no-new-privileges:true"), `${name} no-new-privileges`);
  }

  // postgres: all capabilities dropped, only the entrypoint minimum re-added.
  const pgDrop = s.postgres?.cap_drop ?? [];
  const pgAdd = [...(s.postgres?.cap_add ?? [])].sort();
  check(pgDrop.includes("ALL"), "postgres cap_drop: ALL");
  check(JSON.stringify(pgAdd) === JSON.stringify(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]), `postgres cap_add is the entrypoint minimum (got: ${pgAdd.join(",")})`);

  if (fails.length) {
    for (const f of fails) console.error("  FAIL " + f);
    process.exit(1);
  }
});
'

echo "▸ DB role / grants checks"
GRANTS="$DIR/db-grants/grants.sql"
INIT="$DIR/postgres-init/10-app-role.sh"
[ -x "$INIT" ] && echo "  ok  postgres-init/10-app-role.sh is executable" || { echo "  FAIL $INIT missing or not executable" >&2; exit 1; }
grep -q 'db-grants/grants.sql' "$INIT" && echo "  ok  init applies grants.sql" || { echo "  FAIL init does not apply grants.sql" >&2; exit 1; }
[ -f "$DIR/db-grants/apply-grants.mjs" ] && echo "  ok  db-grants/apply-grants.mjs present" || { echo "  FAIL apply-grants.mjs missing" >&2; exit 1; }
for p in \
  "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" \
  "GRANT SELECT, INSERT ON TABLE public.audit_events TO devdigest_app" \
  "REVOKE ALL ON TABLE public.audit_events FROM devdigest_app" \
  "REVOKE ALL ON SCHEMA drizzle FROM devdigest_app" \
  "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devdigest_app" \
  "REVOKE CREATE ON SCHEMA public FROM PUBLIC"; do
  grep -Fq "$p" "$GRANTS" && echo "  ok  grants.sql: $p" || { echo "  FAIL grants.sql lacks: $p" >&2; exit 1; }
done
if grep -Eiq 'GRANT[^;]*(TRUNCATE|REFERENCES|TRIGGER|ALL PRIVILEGES)' "$GRANTS"; then
  echo "  FAIL grants.sql grants TRUNCATE/REFERENCES/TRIGGER/ALL" >&2; exit 1
else echo "  ok  grants.sql never grants TRUNCATE/REFERENCES/TRIGGER/ALL"; fi
if grep -Eq "PASSWORD '[^']" "$GRANTS" "$INIT"; then
  echo "  FAIL hard-coded password literal in grants/init" >&2; exit 1
else echo "  ok  no hard-coded password in grants/init"; fi

echo "▸ Dockerfile checks"
fail=0
for f in "$DIR/api.Dockerfile" "$DIR/web.Dockerfile"; do
  n="$(basename "$f")"
  # Pinned base image: a concrete version, never :latest or tag-less.
  if grep -Eq '^(FROM|ARG NODE_IMAGE=)[^#]*:latest' "$f" || ! grep -Eq '^(FROM[[:space:]]+|ARG NODE_IMAGE=)node:[0-9]+\.[0-9]+\.[0-9]+' "$f"; then
    echo "  FAIL $n: base image not pinned to an exact node version" >&2; fail=1
  else echo "  ok  $n pinned base image"; fi
  if [ "$(grep -E '^USER ' "$f" | tail -n1 | awk '{print $2}')" != "node" ]; then
    echo "  FAIL $n: final USER is not the non-root \"node\" user" >&2; fail=1
  else echo "  ok  $n runs as non-root"; fi
  if grep -Ei '^(ARG|ENV)[[:space:]].*(SECRET|TOKEN|PASSWORD|MASTER_KEY|API_KEY|CLIENT_ID)' "$f" >/dev/null; then
    echo "  FAIL $n: secret-like ARG/ENV baked into the image" >&2; fail=1
  else echo "  ok  $n has no secret ARG/ENV"; fi
  if grep -Eq '^COPY[[:space:]]+(\.|client|server|reviewer-core)/?[[:space:]]' "$f" || grep -Eq '\.env' <(grep -E '^COPY' "$f"); then
    echo "  FAIL $n: copies a whole package dir or a .env file" >&2; fail=1
  else echo "  ok  $n copies explicit paths only (no .env)"; fi
done
[ "$fail" -eq 0 ] || exit 1

echo "▸ Caddyfile checks"
CADDY="$DIR/Caddyfile"
grep -q '^{\$PUBLIC_HOSTNAME} {' "$CADDY" && echo "  ok  site address is {\$PUBLIC_HOSTNAME}" || { echo "  FAIL site address" >&2; exit 1; }
grep -q 'handle_path /api/\*' "$CADDY" && grep -q 'reverse_proxy api:3001' "$CADDY" && echo "  ok  /api/* → api:3001 (prefix stripped)" || { echo "  FAIL api route" >&2; exit 1; }
grep -q 'reverse_proxy web:3000' "$CADDY" && echo "  ok  default → web:3000" || { echo "  FAIL web route" >&2; exit 1; }
grep -q 'Strict-Transport-Security' "$CADDY" && echo "  ok  HSTS header" || { echo "  FAIL HSTS" >&2; exit 1; }
grep -Eq '^[[:space:]]*-Server$' "$CADDY" && echo "  ok  Server header stripped" || { echo "  FAIL -Server" >&2; exit 1; }
for h in \
  'X-Content-Type-Options "nosniff"' \
  'Referrer-Policy "strict-origin-when-cross-origin"' \
  'X-Frame-Options "DENY"'; do
  grep -Fq "header ?$h" "$CADDY" && echo "  ok  $h" || { echo "  FAIL missing header $h" >&2; exit 1; }
done
CSP_LINE="$(grep -F 'header ?Content-Security-Policy' "$CADDY" || true)"
[ -n "$CSP_LINE" ] || { echo "  FAIL missing Content-Security-Policy" >&2; exit 1; }
for d in "frame-ancestors 'none'" "base-uri 'self'" "object-src 'none'" "form-action 'self'"; do
  case "$CSP_LINE" in *"$d"*) ;; *) echo "  FAIL CSP lacks $d" >&2; exit 1 ;; esac
done
case "$CSP_LINE" in *script-src*|*style-src*|*default-src*) echo "  FAIL CSP must not restrict scripts/styles (Next.js inline)" >&2; exit 1 ;; esac
echo "  ok  CSP (frame-ancestors/base-uri/object-src/form-action, no script/style restriction)"
if grep -Eq '^[[:space:]]*(auto_https[[:space:]]+off|http://)' "$CADDY"; then
  echo "  FAIL automatic HTTPS disabled" >&2; exit 1
else echo "  ok  automatic HTTPS + HTTP→HTTPS redirect left on"; fi

echo "✔ all deployment checks passed"
