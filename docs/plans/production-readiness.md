# Implementation Plan: Production readiness for the single-VM google-mode deployment

## Overview
This plan implements `specs/2026-11-06-production-readiness.md`
(SPEC-2026-11-06-production-readiness, draft, AC-1 – AC-61, gaps G-1 – G-9, decisions D-1 – D-12).
It extends the merged multi-user server (`specs/2026-10-19-multi-user-server.md`, plan
`docs/plans/multi-user-server.md`) with what an operator needs to run it on a real VM:
- a deployment runbook;
- a safe update / rollback script;
- nightly local backups made by a read-only role, with a restore covered by a test;
- a credential-free smoke check;
- log rotation and resource limits;
- opt-in, scrubbed Sentry error reporting for API and web;
- an explicit zero-agents state in the UI and a 409 on the server.

reviewer-core, the existing `@devdigest/shared` contracts, `mcp/`, `db:bootstrap` and every applied
migration stay unchanged.

## Execution mode
**multi-agent (parallel)**, recommended. The work splits into 8 independent areas with disjoint files:
- deploy config;
- backup role + backup service;
- update script;
- smoke script;
- Sentry server core;
- server 409;
- Sentry client;
- zero-agents UI.

Only two areas need a second wave: the Sentry server wiring touches the hot bootstrap files after the
core lands, and the runbook must quote the final names. Single-agent would work too (11 tasks), but it
would serialise about 8 independent tasks for no gain. The plan is written so that a single agent can
run it top to bottom in T-order.

All implementers share one branch (`feat/production-readiness`, cut from `main`), with no worktrees.
**Never `git stash` while agents are working.** Every task writes and runs its own tests (no separate
test-writer pass).

### Waves

| Wave | Tasks (run concurrently) | Gate to next wave |
|---|---|---|
| 1 | T1 deploy config · T2 backup role + service · T3 update script · T4 smoke script · T5 Sentry server core · T6 server 409 · T7 Sentry client · T8 zero-agents UI | each task's Acceptance green |
| 2 | T9 Sentry server wiring (needs T5) · T10 runbook + README (needs T1–T5, T7) | each task's Acceptance green |
| 3 | T11 verification gate (no code) | full verification matrix green |

```mermaid
flowchart LR
  subgraph W1[Wave 1 - independent areas]
    T1[T1 compose / env / check-compose / web.Dockerfile]
    T2[T2 backup role + backup service script]
    T3[T3 update.sh + dc.sh]
    T4[T4 smoke.sh]
    T5[T5 Sentry server core]
    T6[T6 run-all 409]
    T7[T7 Sentry client]
    T8[T8 zero-agents UI]
  end
  subgraph W2[Wave 2]
    T9[T9 Sentry server wiring]
    T10[T10 runbook + README]
  end
  T11[T11 verification gate]
  T5 --> T9
  T1 --> T10
  T2 --> T10
  T3 --> T10
  T4 --> T10
  T5 --> T10
  T7 --> T10
  T6 --> T11
  T8 --> T11
  T9 --> T11
  T10 --> T11
```

### Hot files — sole owner

| Hot file | Sole owner |
|---|---|
| `deploy/compose.yml`, `deploy/.env.example`, `deploy/check-compose.sh`, `deploy/web.Dockerfile`, root `.gitignore` | T1 |
| `deploy/db-grants/*`, `deploy/backup/*` | T2 |
| `deploy/update.sh`, `deploy/dc.sh` | T3 |
| `deploy/smoke.sh` | T4 |
| `server/package.json`, `server/pnpm-lock.yaml`, `server/src/platform/config.ts`, `server/.dependency-cruiser.cjs` | T5 |
| `server/src/platform/container.ts`, `server/src/app.ts`, `server/src/server.ts`, `server/src/platform/jobs.ts`, `server/src/modules/reviews/run-executor.ts`, `server/src/modules/publish/runner.ts` | T9 |
| `server/src/modules/reviews/service.ts` | T6 |
| `client/package.json`, `client/pnpm-lock.yaml`, `client/src/lib/providers.tsx`, `client/src/app/{error,global-error}.tsx` | T7 |
| `client/messages/en/{prReview,agents}.json` | T8 |
| `docs/deployment.md`, `README.md` | T10 |

## Requirements (verified)
Source: `specs/2026-11-06-production-readiness.md`. The ids are the spec's AC ids, restated as checks.

**Runbook (US-1, US-9)**
- R-AC1: `docs/deployment.md` exists and is linked from a README section "Deploying for a team (server mode)". It covers, in this order: prerequisites, DNS, Google OAuth, `deploy/.env`, static check, first start, first Admin, keys, agents, MCP, smoke, update, rollback, backup & restore, disk & logs, Sentry, troubleshooting.
- R-AC2: Prerequisites give min/recommended VM size, OS family, Docker Engine + Compose versions, ports 80/443 TCP + 443 UDP, and a DNS A/AAAA record set before first start.
- R-AC3: Google OAuth steps: an Internal consent screen, a Web client, and the redirect URI exactly `https://<PUBLIC_HOSTNAME>/api/auth/google/callback`. Also the mapping to `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `AUTH_ALLOWED_DOMAIN`.
- R-AC4: One generation command per secret, `chmod 600 deploy/.env`, store the master key + the 3 DB passwords off the VM, and "a dump cannot decrypt provider secrets without the master key".
- R-AC5: First-run order: check-compose → first `up` → smoke → first Admin → keys / `secrets:import` → create agents manually (zero agents, no demo data) → connect the first repo.
- R-AC6: MCP: a personal token, `DEVDIGEST_API_BASE=https://<host>/api` and `DEVDIGEST_API_TOKEN`; never commit the token; link the token-revocation spec.
- R-AC7: Troubleshooting covers symptom / cause / fix for these 9 cases: cert not issued, `redirect_uri_mismatch`, sign-in bounce, `migrate` non-zero, "another instance", "No admin", undecryptable secrets, disk full, OOM restart.
- R-AC8: Every setting named in the runbook exists in `.env.example`. Every `.env.example` setting is commented as secret / required / optional, with its default. `check-compose.sh` fails on a runbook setting that is missing from `.env.example`.

**Update & rollback (US-2, US-3)**
- R-AC9: Preflight refusals: no `deploy/.env`, a dirty tracked tree, the wrong branch, or the lock is held. Each gives a distinct message, a non-zero exit, and no change to HEAD, images, containers or DB.
- R-AC10: No new remote commits → "already up to date", exit 0, no dump, no build, no restart, < 30 s.
- R-AC11: A pre-update dump (same guarantees as AC-23 – AC-26, named with the old sha), then the state records `previous_sha`. A failed dump aborts with nothing changed.
- R-AC12: Fast-forward only. If that is impossible, abort before the build with HEAD unchanged.
- R-AC13: After the pull, check-compose + build while the old containers keep serving. On failure: check out the previous sha, leave the containers untouched, exit 1.
- R-AC14: New migrations → stop `api` before `migrate` runs. No new migrations → the normal recreate.
- R-AC15: Wait (default 180 s) for `api` + `web` healthy, then run the smoke check. Success prints `old → new` and "smoke: ok", exit 0.
- R-AC16: Failure with no migration applied → auto-rollback to the previous sha and previous images (rebuild only if they are missing), wait for health, exit 2 with "rolled back to <sha>".
- R-AC17: Failure after a migration was applied → no DB restore. Exit 3, print the exact restore + redeploy commands with the dump name, and warn about data loss.
- R-AC18: `--help` and the runbook state that migrations are forward-only and what a dump restore loses.
- R-AC19: `rollback` mode redeploys the recorded previous sha. It refuses (and names the dump) when the DB has migrations that sha lacks.
- R-AC20: On success, prune dangling images + build cache, keeping only the images of the current and previous commits.
- R-AC21: No secret value ever appears in update / rollback output (canary test).

**Backups & restore (US-4)**
- R-AC22: A long-lived `backup` service: no published ports, only on the `db` network. It makes a nightly full logical dump at `BACKUP_SCHEDULE` (default 03:15 UTC) in a compressed, restorable format that includes the migrations journal and `audit_events`.
- R-AC23: A dedicated read-only role. It can SELECT every table and sequence; every write and DDL fails. Only `migrate` creates / re-keys it, from `BACKUP_DB_PASSWORD` (≥ 32 chars of `[A-Za-z0-9_-]`, different from the other two passwords). `migrate` and `check-compose.sh` both reject a bad value, naming the setting only.
- R-AC24: The backup password never appears in argv, logs, dump names or dump contents.
- R-AC25: Write to a temp name, verify the TOC, then rename. On failure: delete the temp file, keep all earlier dumps, log, and keep running.
- R-AC26: Rotation keeps the newest `BACKUP_RETAIN` nightly dumps (default 14, min 1) and `BACKUP_RETAIN_PRE_UPDATE` pre-update dumps (default 5, min 1), each kind separately. It never rotates after a failed dump.
- R-AC27: `BACKUP_DIR` (default: a git-ignored dir under `deploy/`), mode 0700, files 0600, and `git status` stays clean.
- R-AC28: The service is unhealthy when no dump succeeded in the last 26 h, after a 26 h grace period from its first start.
- R-AC29: The runbook's restore procedure (5 steps) and the same-master-key warning.
- R-AC30: An integration test: seed every table → dump as the backup role → restore the documented way. It asserts equal per-table counts, that a following `migrate` applies nothing, and that the runtime role's privileges match `grants.sql`.
- R-AC31: A runbook warning block: backups are local only, losing the VM loses all backups, and the operator should copy dumps off the VM by hand.

**Sentry (US-5)**
- R-AC32: The API reports only when `SENTRY_DSN` is non-empty and `NODE_ENV ≠ test`. Otherwise there is no reporter init and no connection, and the existing suite passes with no new config.
- R-AC33: The web app reports only when the build-time DSN is non-empty. Otherwise the bundle makes no Sentry request.
- R-AC34: The API reports 5xx errors, uncaught exceptions / unhandled rejections, and internal background-job failures (clone, index, review run, publish). It never reports 4xx, validation errors, or AppErrors below 500.
- R-AC35: The web app reports error-boundary render errors (route + global) and browser unhandled rejections. It never reports API error responses.
- R-AC36: Scrubbing removes every canary class (auth / cookie headers, session ids, PATs, provider tokens, master key, Google client secret / ID token / OAuth code + state, DB passwords) from every event field. It attaches no request bodies and captures no local variables.
- R-AC37: The API exception message goes through `redactSecret` (`server/src/platform/redact.ts`).
- R-AC38: `user` = `{ id }` only. No email, name, avatar or IP.
- R-AC39: `release` = the deployed sha (the same for API and web), else `unknown` without failing. `environment` is configurable (default `production`).
- R-AC40: Errors only: no tracing, profiling or Replay.
- R-AC41: reviewer-core has no Sentry dependency, and `pnpm arch` rejects a Sentry import there.
- R-AC42: An unreachable / rate-limited / malformed DSN never affects requests, jobs, boot or shutdown. A malformed DSN logs one boot warning that names the setting.
- R-AC43: On shutdown, flush pending events for ≤ 2 s, inside the shutdown window.
- R-AC44: The web DSN is a public, build-time value (documented). If the CSP restricts `connect-src` / `default-src`, `check-compose.sh` fails unless the web DSN's ingest origin is allowed.

**Compose hygiene (US-7)**
- R-AC45: Every service uses `json-file` logging with max-size / max-file (default 10m × 5), configurable.
- R-AC46: Every service has a memory + CPU limit (NFR table defaults), each overridable.
- R-AC47: An OOM-killed long-lived service restarts. Orphaned runs are reaped on boot (existing behaviour).
- R-AC48: The runbook lists the disk growth sources (pgdata, clones — never deleted on repo removal, `BACKUP_DIR`, images / build cache, logs). It gives a usage command per source, a manual clone-deletion procedure, and the advice to act at 80 %.
- R-AC49: `check-compose.sh` asserts for `backup`: no ports, `db`-only network, the backup DB user, no other secret-like env, the same Postgres major version as `postgres`, `restart: unless-stopped`, `no-new-privileges`, and a health check.

**Smoke (US-6)**
- R-AC50: `smoke <bare-host>` runs AC-51 – AC-56 without credentials or cookies. It prints one `ok|FAIL <name> [hint]` line per check and exits 0 only if all pass.
- R-AC51: `http://<host>/` → a permanent redirect to `https://<host>/`.
- R-AC52: A valid certificate with no insecure bypass, and HSTS `max-age ≥ 31536000`.
- R-AC53: `GET /api/health/ready` → 200 `ready: true`.
- R-AC54: An unauthenticated protected API route → 401.
- R-AC55: `/api/auth/google/start` → a redirect to host `accounts.google.com`. A redirect to the sign-in error page → FAIL with a `TRUST_PROXY` hint.
- R-AC56: `GET /` → 200 HTML from web.
- R-AC57: A host with a scheme, port, path or userinfo, or an unresolvable host → non-zero within 15 s with a message naming the problem.

**Zero agents (US-8)**
- R-AC58: Zero enabled agents → "Run all" is focusable and `aria-disabled`, sends no request, and shows a localized hint.
- R-AC59: Zero agents → a role-aware entry. Admin: "No agents yet — create one" → `/agents` with the create flow open. Member: "…ask an Admin to create one", non-actionable. No hard-coded English.
- R-AC60: Empty Agents list + Member → the empty state says only an Admin can create agents. The Admin empty state is unchanged.
- R-AC61: Run-all with no enabled agent → `409 { error: { code: "no_enabled_agents", message } }`, and no `agent_runs` row is created.

**NFRs:** the VM size and resource-limit table, ≤ 50 MB of logs per container, update downtime ≤ 120 s (no migrations), rollback ≤ 5 min, each smoke request ≤ 10 s and the whole run ≤ 60 s, a 2 GB dump ≤ 15 min with `/health/ready` p95 < 200 ms during the dump, Sentry p95 overhead < 5 ms, and no secret in any output / argv / log / event / image layer.

### Assumptions (spec Open questions → the spec's stated defaults; user decisions already given)
- A1 (D-1, user): delivery = `git pull` + build on the VM. No registry, no CI deploy.
- A2 (D-2, user): local nightly `pg_dump` only. Off-site copies are manual (AC-31).
- A3 (D-3, user): Sentry for API **and** web, opt-in by DSN.
- A4 (D-4, user): built-in agents are created manually in the UI. **`server/src/db/bootstrap.ts` is not touched.**
- A5 (OQ G-6): removing a repo does **not** delete its clone, and the GitHub fetch depth is unchanged. Both are documented as a manual procedure (AC-48) and remain a follow-up spec.
- A6 (OQ hosting): any DSN works (sentry.io US / EU or self-hosted). The runbook states that the region choice is company policy.
- A7 (OQ source maps): no source-map upload and no build-time Sentry auth token. Web stack traces stay minified.
- A8 (OQ backup visibility): container health + a runbook check only. No Admin UI line.
- A9 (OQ provider errors): only **internal** errors are reported. Provider failures (LLM / host 4xx / 5xx / rate limits, `ExternalServiceError`, SDK errors with a numeric `status`) are not (see D-P3).
- A10 (OQ sizing): resource-limit defaults = the spec's Non-functional table. Confirming them on real repos happens in the T11 VM drill.
- A11 (OQ deploy branch): `DEPLOY_BRANCH` (default `main`) and `DEPLOY_REMOTE` (default `origin`) are new optional `deploy/.env` settings. The runbook documents one read path: a read-only **GitHub deploy key** (SSH).

## Open questions & recommendations
The user's decisions cover the shape of the plan, so no question blocks it. These are the
plan-level choices and the places where the plan diverges from or extends the spec. Each needs a
quick confirm in review.

- **Q1 (gap): hairpin NAT breaks the update's smoke check.** The update script runs the smoke check from
  the VM against `PUBLIC_HOSTNAME`. On many clouds the VM cannot reach its own public IP, so every
  update would auto-roll back. → default: `smoke.sh` honours an optional env var `SMOKE_RESOLVE_IP`.
  When it is set, every request uses `curl --resolve <host>:80:<ip> --resolve <host>:443:<ip>`, which
  keeps SNI, certificate validation and the full Caddy → API chain. `update.sh` sets it to `127.0.0.1`.
  The spec's CLI ("one positional bare host") stays the same; this is an env extension. The runbook
  documents it.
- **Q2 (gap): AC-16 needs per-commit images.** Today both images are tagged `:local`, so "bring back
  the previous images" is impossible. → default: `image: devdigest-api:${DEVDIGEST_IMAGE_TAG:-local}`
  (same for web). `update.sh`:
  - tags the **running** images as `:<prev-sha12>` before building;
  - builds as `:<new-sha12>`;
  - on success re-tags `:<new-sha12>` as `:local`, so a plain `docker compose … up -d` still runs the
    current version.

  `deploy/.state/release.env` holds `DEVDIGEST_IMAGE_TAG` + `DEVDIGEST_RELEASE`, and `deploy/dc.sh`
  exports them before calling `docker compose` (shell env overrides `.env` interpolation, so this
  works with any Compose v2). The runbook uses `deploy/dc.sh` everywhere.
- **Q3 (gap): first adoption on an existing deployment.** The running version has no `update.sh`, no
  `backup` service, no backup role and no `BACKUP_DB_PASSWORD`. A plain `update.sh` cannot bootstrap
  itself. → default: the runbook's *Update* section gets an "Adopting this on an existing deployment
  (one time)" subsection:
  1. a manual dump with `pg_dump` as the owner via `docker compose exec`;
  2. `git pull --ff-only`;
  3. add `BACKUP_DB_PASSWORD` and the new settings;
  4. `install -d` the backup dir;
  5. `deploy/dc.sh up -d --build`;
  6. run the smoke check.

  From then on, use `update.sh`.
- **Q4 (gap): Node on the VM.** `check-compose.sh` already requires `node`, but AC-2 lists only
  Docker. → default: the runbook prerequisites list Node.js 22 LTS (used only by `check-compose.sh`).
- **Q5 (scope, AC-30): "seeds rows in every table".** → default: the test seeds through
  `src/db/seed.ts`'s exported seeding (if it exports none, through direct inserts) plus targeted inserts
  for the rest. It then asserts that the set of public tables with 0 rows is **empty**. A table that
  cannot be seeded meaningfully goes in an explicit, commented allowlist inside the test, and that
  allowlist is reported in T2's hand-off.
- **Q6 (spec edge case is moot): MCP "all".** The MCP `run-agent-on-pr` tool runs one agent and has no
  "all" mode (`mcp/src/tools/run-agent-on-pr.ts`), so the 409 never reaches MCP. `mcp/` stays unchanged.
- **Rec1 (D-P1): no new `@devdigest/shared` file.** `no_enabled_agents` is a plain string constant on
  both sides (server `modules/reviews/constants.ts`, client `RunReviewDropdown/constants.ts`), each
  asserted by a test. The spec says the shared contracts don't change, and one literal does not justify
  the twice-vendored sync cost.
- **Rec2 (D-P2): Sentry behind a structural port, not a shared-contract port.**
  - `server/src/platform/error-reporting.ts` defines `ErrorReporter { capture(err, ctx): void; flush(ms): Promise<boolean> }`, a `NoopErrorReporter`, and the pure `isReportable(err)`.
  - The only file that imports `@sentry/node` is `server/src/adapters/sentry/sentry-reporter.ts`.
  - The container builds it and is the only importer.

  This follows the existing structural `JobLogger` / `SyncLogger` pattern, and it keeps
  `vendor/shared` out of it (no client mirror).
- **Rec3 (D-P3): what is "internal".** `isReportable(err)` is false for:
  - `RunCancelledError`;
  - `AppError` with `statusCode < 500`;
  - `ExternalServiceError` (502);
  - any error carrying a numeric `status` / `statusCode` < 500 or ≥ 500 from a provider SDK (objects with `status` + `headers`, the OpenAI / Octokit / GitLab-http shape).

  Everything else is reportable. One table-driven test pins this down.
- **Rec4 (D-P4): no breadcrumbs, both sides.** Set `maxBreadcrumbs: 0` and drop breadcrumbs in
  `beforeSend`. This removes the main leak path for URLs with `code` / `state`, and AC-36 still holds
  when scrubbing is the second line.
- **Rec5 (D-P5): `@sentry/node` errors-only init.** Use `defaultIntegrations: false` with an explicit
  minimal list (`linkedErrors`, `dedupe` only), `skipOpenTelemetrySetup: true`, `sendDefaultPii: false`,
  `includeLocalVariables: false`, and no `tracesSampleRate` / `profilesSampleRate` (undefined ⇒ off).
  The SDK's own process handlers are disabled. `server.ts` installs its own handlers (T9), and only when
  a DSN is active. Verify the exact option names with context7 for the installed major version.
- **Rec6 (D-P6): web = `@sentry/browser`, not `@sentry/nextjs`.** The web app makes no server-side API
  calls, needs no source maps (A7) and no tracing. `@sentry/nextjs` would wrap `next.config.mjs`, add
  server / edge instrumentation and a build plugin. Init happens in `client/src/instrumentation-client.ts`
  (Next 15.5.19 supports it), with the SDK imported dynamically only when the DSN is non-empty.
- **Rec7 (follow-up, out of scope):**
  - a CI job running `deploy/tests/*.sh` + `shellcheck`;
  - the G-6 clone-deletion server spec;
  - a root `CLAUDE.md` "Read when" line for this spec (CLAUDE.md is not a doc-writer path, and it currently has uncommitted edits).

## Affected modules & contracts
- **deploy** — `compose.yml` (a `backup` service, logging, limits, image tags, Sentry env / args, backup password for `migrate`), `.env.example`, `check-compose.sh`, `web.Dockerfile`, new `db-grants/backup-role.sql`, `db-grants/apply-grants.mjs`, new `backup/devdigest-backup.sh`, new `update.sh`, `dc.sh`, `smoke.sh`, and new `tests/*.test.sh`.
- **server** — `platform/config.ts` (3 settings), new `platform/error-reporting.ts`, new `platform/sentry-scrub.ts`, new `adapters/sentry/sentry-reporter.ts`, the container getter + override, the capture points (`app.ts`, `server.ts`, `jobs.ts`, `reviews/run-executor.ts`, `publish/runner.ts`), `reviews/service.ts` (409), and `.dependency-cruiser.cjs` (a reviewer-core Sentry ban). No migration, no schema change.
- **client** — new `src/instrumentation-client.ts`, new `src/lib/monitoring/*`, `app/error.tsx`, `app/global-error.tsx`, `lib/providers.tsx` (user id), `RunReviewDropdown`, `AgentsListView`, `messages/en/{prReview,agents}.json`.
- **docs** — new `docs/deployment.md`, and a `README.md` section.
- **unchanged (verified in T11)** — `reviewer-core/`, `mcp/`, `server/src/db/bootstrap.ts`, `server/src/db/migrations/**`, `server/src/vendor/shared/**`, `client/src/vendor/shared/**`.
- **Contracts:** none added or edited in `@devdigest/shared` (Rec1). The new error code is a value in the existing `ApiErrorBody` envelope.

## Architecture changes

### Deploy interface contract (fixed here so wave-1 tasks can run in parallel)
Every name below is binding. A task that needs a different name must stop and report back, not
improvise.

**Paths & state**
- `deploy/backups/` — default `BACKUP_DIR` (git-ignored). The container path is `/backups`.
- `deploy/.state/` (git-ignored, mode 0700):
  - `release.env` — `DEVDIGEST_RELEASE=<full sha>` and `DEVDIGEST_IMAGE_TAG=<sha12>`.
  - `update.env` — `previous_sha=`, `current_sha=`, `pre_update_dump=`, `migrations_applied=true|false` (spec *Contracts*).
  - `update.lock.d/` — an `mkdir` lock holding a `pid` file (portable: macOS has no `flock`).
- `deploy/dc.sh [compose args…]` — `cd`s to `deploy/`, exports `release.env` if present, then
  `exec docker compose -f compose.yml "$@"` (the default `.env` is loaded from `deploy/`).

**compose.yml (T1)**
- `api` and `migrate` use `image: devdigest-api:${DEVDIGEST_IMAGE_TAG:-local}`. `web` uses
  `image: devdigest-web:${DEVDIGEST_IMAGE_TAG:-local}`.
- The `api` env adds `SENTRY_DSN: ${SENTRY_DSN:-}`, `SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT:-production}`
  and `SENTRY_RELEASE: ${DEVDIGEST_RELEASE:-unknown}`.
- The `web` build args add `NEXT_PUBLIC_SENTRY_DSN: ${SENTRY_WEB_DSN:-}`,
  `NEXT_PUBLIC_SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT:-production}` and
  `NEXT_PUBLIC_SENTRY_RELEASE: ${DEVDIGEST_RELEASE:-unknown}`. **`SENTRY_DSN` must never be a web build arg.**
- The `migrate` env adds `BACKUP_DB_PASSWORD: ${BACKUP_DB_PASSWORD:?…}`.
- `backup` service:

  ```yaml
  backup:
    image: pgvector/pgvector:0.8.1-pg16           # same image string as postgres (AC-49)
    entrypoint: ["sh", "/opt/devdigest/backup/devdigest-backup.sh"]
    command: ["daemon"]
    user: "999:999"                               # the image's postgres uid/gid
    read_only: true
    tmpfs: ["/tmp:mode=1777,size=16m"]
    restart: unless-stopped
    init: true
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    environment:
      PGHOST: postgres
      PGPORT: "5432"
      PGDATABASE: devdigest
      PGUSER: devdigest_backup
      BACKUP_DB_PASSWORD: ${BACKUP_DB_PASSWORD:?…}
      BACKUP_SCHEDULE: ${BACKUP_SCHEDULE:-03:15}
      BACKUP_RETAIN: ${BACKUP_RETAIN:-14}
      BACKUP_RETAIN_PRE_UPDATE: ${BACKUP_RETAIN_PRE_UPDATE:-5}
      TZ: UTC
    volumes:
      - ${BACKUP_DIR:-./backups}:/backups
      - ./backup:/opt/devdigest/backup:ro
    networks: [db]
    depends_on: { postgres: { condition: service_healthy } }
    healthcheck:
      test: ["CMD", "sh", "/opt/devdigest/backup/devdigest-backup.sh", "health"]
      interval: 5m
      timeout: 10s
      retries: 1
      start_period: 30s
  ```

- Every service gets `logging: { driver: json-file, options: { max-size: ${LOG_MAX_SIZE:-10m}, max-file: "${LOG_MAX_FILE:-5}" } }`
  (an `x-logging` anchor) and `deploy.resources.limits: { memory: ${<SVC>_MEM_LIMIT:-…}, cpus: "${<SVC>_CPUS:-…}" }`.
  `<SVC>` ∈ `PROXY, WEB, API, MIGRATE, POSTGRES, BACKUP`; the defaults come from the NFR table
  (`256m/0.5, 512m/1.0, 2g/1.5, 1g/1.0, 1g/1.0, 512m/0.5`). `api` keeps `deploy.replicas: 1`.

**Backup script CLI (T2)** — `deploy/backup/devdigest-backup.sh`, POSIX `sh` (the image has no bash guarantee):
- `daemon` — touches `/backups/.first-start` if it is absent and runs `chmod 700 /backups`. Then it
  loops: sleep until the next `BACKUP_SCHEDULE` (HH:MM UTC), then `dump nightly`. A failure is logged
  to stderr and the loop continues.
- `dump nightly` | `dump pre-update <sha7>` — `pg_dump -Fc` to `/backups/.tmp-<final>` (umask 077), then
  `pg_restore --list` verification, then `mv` to the final name, then rotation of that kind only. The
  last stdout line is `dump: <final-filename>`. Exit 0 on success, 1 on failure (temp file removed, no
  rotation).
- `health` — exit 0 if a `*-nightly.dump` exists with mtime < 1560 min, **or** `.first-start` is younger
  than 1560 min. Otherwise exit 1.
- File name: `devdigest-<yyyymmddThhmmssZ>-nightly.dump` / `devdigest-<…Z>-pre-update-<sha7>.dump`.
- Password: written once to `/tmp/.pgpass` (0600, `PGPASSFILE`). `BACKUP_DB_PASSWORD` is then
  `unset` in the script's own environment and is never passed as an argument.

**DB role (T2)** — `devdigest_backup`:
- `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
- member of `pg_read_all_data` only;
- `ALTER ROLE devdigest_backup SET default_transaction_read_only = on`;
- `CONNECT` on the database;
- no `CREATE` / `TEMP`.

It is created / re-keyed by `deploy/db-grants/backup-role.sql`, which `apply-grants.mjs` applies
right after `grants.sql` in the same `migrate` run. The password is passed through the session GUC
`devdigest.backup_password`, set as a bound parameter, exactly like the app password.

**Update script CLI (T3)** — `deploy/update.sh [update|rollback] [--help]`:
- exit codes `0` / `1` / `2` / `3` as in the spec;
- reads **only** `DEPLOY_BRANCH`, `DEPLOY_REMOTE`, `UPDATE_HEALTH_TIMEOUT`, `PUBLIC_HOSTNAME`,
  `BACKUP_DIR` and `BACKUP_RETAIN_PRE_UPDATE` from `deploy/.env`, key by key (it never `source`s the file);
- runs the pre-update dump as `deploy/dc.sh run --rm -T backup dump pre-update <sha7>`;
- calls `SMOKE_RESOLVE_IP=127.0.0.1 deploy/smoke.sh "$PUBLIC_HOSTNAME"`;
- reads the DB's applied-migration count through the backup role:
  `deploy/dc.sh exec -T backup psql -tAc 'select count(*) from drizzle.__drizzle_migrations'`
  (no password in argv: the backup container has its passfile). If `backup` is not running, it uses
  `run --rm` instead.

**Smoke script CLI (T4)** — `deploy/smoke.sh <bare-host>`, plus the optional env `SMOKE_RESOLVE_IP`.
The check names, in order: `http-redirect`, `tls-hsts`, `ready`, `auth-barrier` (`GET /api/repos`),
`google-redirect`, `web-html`.

**New `deploy/.env` settings (T1 documents them; T10 quotes them):**
`BACKUP_DB_PASSWORD`, `BACKUP_SCHEDULE`, `BACKUP_RETAIN`, `BACKUP_RETAIN_PRE_UPDATE`, `BACKUP_DIR`,
`SENTRY_DSN`, `SENTRY_WEB_DSN`, `SENTRY_ENVIRONMENT`, `LOG_MAX_SIZE`, `LOG_MAX_FILE`,
`{PROXY,WEB,API,MIGRATE,POSTGRES,BACKUP}_{MEM_LIMIT,CPUS}`, `DEPLOY_BRANCH`, `DEPLOY_REMOTE`,
`UPDATE_HEALTH_TIMEOUT`.
- `DEVDIGEST_RELEASE` / `DEVDIGEST_IMAGE_TAG` are **not** operator settings (state file only). The
  AC-8 check must skip them.
- Every `.env.example` setting carries a comment line of the form
  `# [secret|non-secret] [required|optional] default: <value|none>` directly above it (the format the AC-8 check parses).

**Runbook settings table (T10 ↔ T1):** `docs/deployment.md` has a `## Settings reference` section.
Each setting row starts with ``| `NAME` |``. `check-compose.sh` extracts the names from that section
only, and checks them against `.env.example`.

### Server (onion placement)
- **core / platform (structural port):** `server/src/platform/error-reporting.ts` — the
  `ErrorReporter` interface, `NoopErrorReporter`, `isReportable(err)`, and a
  `ReportContext = { userId?: string; route?: string; method?: string; status?: number; jobKind?: string; runId?: string }` type.
- **domain-ish pure helper:** `server/src/platform/sentry-scrub.ts` — `scrubEvent(event, extraSecrets)`
  and `scrubString(s, extraSecrets)`, built on `redactSecret`. No Sentry import: it types the event
  structurally.
- **infrastructure:** `server/src/adapters/sentry/sentry-reporter.ts` — `createSentryReporter({ dsn, environment, release, log })`
  returns an `ErrorReporter`. It is the only `@sentry/node` importer.
- **composition root:** a `container.errorReporter` lazy getter (`overrides.errorReporter` first).
  It returns the Noop when `!config.sentryDsn || config.nodeEnv === 'test'` (D-12), or when the DSN is
  malformed (one warning). The same reporter goes into `new JobRunner(db, { log, reporter })` and
  `new PublishRunner({ …, reporter })`.
- **presentation / bootstrap:** the `app.ts` error handler captures only on the final 5xx branch
  (`isReportable`), plus an `onClose` flush (≤ 2 s). `server.ts` installs
  `process.on('uncaughtException' | 'unhandledRejection')` **only when the reporter is active**:
  capture → `flush(2000)` → keep today's crash semantics (exit 1).
- **application:** `reviews/run-executor.ts` captures in the run-level failure `catch` (not for
  cancel, and only when `isReportable`). `ReviewService.resolveTargets` throws
  `AppError('no_enabled_agents', …, 409)`.
- **arch gate:** a new `.dependency-cruiser.cjs` rule `core-no-sentry` (severity `error`,
  from `REVIEWER_CORE`, to `(^|node_modules/)@sentry/`). It matches both resolved and unresolved
  specifiers.

### Client (RSC boundary)
- `src/instrumentation-client.ts` (client-only by Next convention) calls `initMonitoring()` from
  `src/lib/monitoring/sentry.ts`. When `process.env.NEXT_PUBLIC_SENTRY_DSN` is empty, it returns before
  the dynamic `import("@sentry/browser")`.
- `src/lib/monitoring/index.ts` exports `reportRenderError(error)` (a no-op until init) and
  `setMonitoringUser(id | null)`. `scrub.ts` is pure.
- `app/error.tsx` and `app/global-error.tsx` (already `"use client"`) call `reportRenderError` in their
  existing `useEffect`.
- `lib/providers.tsx` mounts a tiny `<MonitoringUser />` (from `lib/monitoring/`). It reads
  `useSession()` and calls `setMonitoringUser(session.user.id)`.
- The zero-agents UI stays inside its existing client components. `AgentsListView` reads `?create=1`
  through the existing `useQueryParam` (`src/lib/hooks/use-query-param.ts`), and `app/agents/page.tsx`
  wraps the view in `<Suspense>` if the hook needs it (`useSearchParams` CSR bailout).

## Phased tasks

### Phase 1 — Independent areas (wave 1: T1–T8 run concurrently)

- **T1 — Compose hygiene, settings, static checks**
  - **Action:**
    - `deploy/compose.yml`:
      - add the `backup` service exactly as in the interface contract;
      - add `x-logging` to every service and `deploy.resources.limits` to every service (merge into `api`'s existing `deploy`);
      - parametrise the image tags;
      - add the Sentry env / build args and `BACKUP_DB_PASSWORD` for `migrate`;
      - extend the header comment (a backup role line in "Database roles", and "use deploy/dc.sh").
    - `deploy/web.Dockerfile`: add `ARG NEXT_PUBLIC_SENTRY_DSN=`, `ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=production` and
      `ARG NEXT_PUBLIC_SENTRY_RELEASE=unknown`, exported as `ENV` in the build stage only (before `pnpm build`), with a comment that they are public.
    - `deploy/.env.example`:
      - add every new setting from the contract list with the `# [secret|non-secret] [required|optional] default:` line;
      - retrofit that line to every existing setting (AC-8);
      - add `BACKUP_DB_PASSWORD=replace-me-backup-openssl-rand-hex-24`;
      - mark `SENTRY_WEB_DSN` as public / build-time;
      - mark `SENTRY_DSN` "treat as sensitive".
    - Root `.gitignore`: add `deploy/backups/` and `deploy/.state/`.
    - `deploy/check-compose.sh`:
      - allow overrides `COMPOSE_FILE_OVERRIDE`, `CADDYFILE_OVERRIDE` and `RUNBOOK_OVERRIDE` (for tests);
      - add `backup` to the existence checks;
      - add the AC-49 checks: no ports; `networks == ["db"]`; `PGUSER === "devdigest_backup"` and ≠ `POSTGRES_USER` / `devdigest_app`; env keys matching `/SECRET|MASTER_KEY|TOKEN|API_KEY|PASSWORD|DSN/` ⊆ `{BACKUP_DB_PASSWORD}`; image major equals the `postgres` image major (`-pg16` suffix / tag parse); `restart: unless-stopped`; `no-new-privileges`; a healthcheck present;
      - add the AC-45 / AC-46 checks: every service has `logging.options.max-size` + `max-file`, and `deploy.resources.limits.memory` + `cpus`;
      - check that the web build args never contain `SENTRY_DSN`, and that `migrate` has no `/DSN/` key;
      - extend the secret-value checks: `BACKUP_DB_PASSWORD` is set, not a placeholder, `^[A-Za-z0-9_-]{32,}$`, and ≠ `POSTGRES_PASSWORD` and ≠ `APP_DB_PASSWORD`;
      - add grep checks that `db-grants/backup-role.sql` exists and contains `pg_read_all_data`, `default_transaction_read_only`, `replace-?me` and `^[A-Za-z0-9_-]{32,}$`;
      - AC-44: if the CSP line contains `connect-src` and `SENTRY_WEB_DSN` is non-empty, FAIL unless the DSN's `https://<host>` origin appears in it (the existing check already FAILs on any `default-src`);
      - AC-8: parse `## Settings reference` in the runbook (skip with a printed note if the file is absent, FAIL if a name is missing from `.env.example`), and check that every `KEY=` line in `.env.example` has the comment line directly above it.
    - New `deploy/tests/check-compose.test.sh`: a mutation harness. Copy compose / Caddyfile / runbook / env to `mktemp -d`, apply one mutation with `sed`, assert the matching FAIL and a non-zero exit. Run the unmutated set once and assert a pass.
  - **Module:** deploy · **Type:** backend
  - **Skills to use:** security, postgresql-table-design (resource sizing only), typescript-expert (for the inline `node -e` checks)
  - **Owned paths:** `deploy/compose.yml`, `deploy/.env.example`, `deploy/check-compose.sh`, `deploy/web.Dockerfile`, `.gitignore`, `deploy/tests/check-compose.test.sh`
  - **Depends-on:** none
  - **Risk:** medium (it is every operator's entry point, and every later run of `check-compose.sh` depends on it)
  - **Known gotchas:**
    - `docker compose config --format json` renders `cpus` as a number and memory as bytes. Compare parsed values, not the literal strings.
    - `logging.options.max-file` must be a **string** in compose.
    - The existing check pins `migrate.image === api.image`. Keep it true after parametrising.
    - Do not loosen any existing check, and do not reorder the existing ok lines (other docs quote them).
    - `.env.example` is run with `CHECK_SECRETS=0` by default. The new placeholder must be rejected only when `CHECK_SECRETS=1`.
    - The web image ARGs must not match the existing secret-ARG regex (`SECRET|TOKEN|PASSWORD|MASTER_KEY|API_KEY|CLIENT_ID`). `DSN` / `RELEASE` / `ENVIRONMENT` are fine.
    - `deploy/.env` is never read in this task or in its tests. Use generated temp env files with canary values.
  - **Acceptance:**
    - `bash deploy/check-compose.sh` exits 0 (with `.env.example`). It prints new ok lines for `backup` (AC-49 × 7), the logging + limits per service (6 × 2), "web build args have no SENTRY_DSN", and the AC-8 parse (or the "runbook absent" note).
    - `CHECK_SECRETS=1 bash deploy/check-compose.sh deploy/.env.example` exits non-zero and names `BACKUP_DB_PASSWORD` (no value printed).
    - `bash deploy/tests/check-compose.test.sh` exits 0 and covers at least these mutations, each → FAIL:
      - backup publishes a port;
      - backup is on `edge`;
      - `PGUSER: devdigest`;
      - backup env gains `SENTRY_DSN`;
      - backup image `postgres:17`;
      - backup without `restart`;
      - backup without a healthcheck;
      - one service without `logging`;
      - one service without a memory limit;
      - a Caddyfile with `connect-src 'self'` and a web DSN set (AC-44);
      - a runbook settings row `FOO_BAR` that is absent from `.env.example` (AC-8);
      - a `.env.example` key without its comment line;
      - `BACKUP_DB_PASSWORD` equal to `APP_DB_PASSWORD`.
    - `docker compose -f deploy/compose.yml --env-file deploy/.env.example config -q` exits 0.

- **T2 — Read-only backup role + backup service script + restore test**
  - **Action:**
    - New `deploy/db-grants/backup-role.sql` (idempotent, its own `BEGIN/COMMIT`):
      - superuser precondition;
      - GUC `devdigest.backup_password` checks (missing / placeholder / strength, messages name `BACKUP_DB_PASSWORD` only);
      - create or `ALTER ROLE … PASSWORD`;
      - the `ALTER ROLE` attribute set;
      - `GRANT pg_read_all_data`; fail closed if it is a member of any other role or owns any object;
      - `ALTER ROLE … SET default_transaction_read_only = on`;
      - `GRANT CONNECT ON DATABASE`, `REVOKE TEMP`.
    - `deploy/db-grants/apply-grants.mjs`:
      - read `BACKUP_DB_PASSWORD` and apply the same placeholder / strength checks;
      - require it to differ from the owner and app passwords;
      - after `grants.sql`, `set_config('devdigest.backup_password', $1)`, run `backup-role.sql` with `.simple()`, then clear the GUC;
      - success line `✓ backup-role grants applied (devdigest_backup)`.
      - Keep every existing string that `check-compose.sh` greps (`STRONG.test(ownerPassword)`, the placeholder message).
    - New `deploy/backup/devdigest-backup.sh`: implement the CLI from the interface contract.
      - Read the env with defaults and validate: `BACKUP_RETAIN*` integers ≥ 1, else log + use the default; `BACKUP_SCHEDULE` must match `^[0-2][0-9]:[0-5][0-9]$`.
      - Use `umask 077`.
      - Run rotation with `ls -1t` over one kind's glob only, deleting beyond N. Never touch `.tmp-*` from another live run; only a stale temp file is removed, >24 h old.
      - Log lines are `backup: <event> <filename|reason>`, never an env value.
    - New `server/test/helpers/deploy-pg.ts`:
      - starts a **dedicated** `PostgreSqlContainer('pgvector/pgvector:pg16')` (roles are cluster-wide, so the shared broker cluster must not be used);
      - runs the server migrations as the owner;
      - runs `node ../deploy/db-grants/apply-grants.mjs` via `execFile` with env `DATABASE_URL`, `APP_DB_PASSWORD`, `BACKUP_DB_PASSWORD` and `DEVDIGEST_SERVER_PKG=<abs server/package.json>`;
      - copies `deploy/backup/devdigest-backup.sh` into the container (`withCopyFilesToContainer`).
    - New `server/test/backup-role.it.test.ts` (AC-23):
      - As `devdigest_backup`, `SELECT` from every `public` table and from `drizzle.__drizzle_migrations` succeeds.
      - `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE TABLE`, `CREATE TEMP TABLE` and `SET default_transaction_read_only=off; INSERT` each fail, on one representative table plus `audit_events`.
      - `apply-grants.mjs` exits non-zero with a placeholder, a 31-char password, and a password equal to `APP_DB_PASSWORD`. The stderr names `BACKUP_DB_PASSWORD` and does not contain the value.
      - Re-running `apply-grants.mjs` with a new password re-keys the role: the old password fails, the new one connects.
    - New `server/test/backup-restore.it.test.ts` (AC-22, AC-24 – AC-27, AC-30):
      - Seed every public table (Q5). Run `devdigest-backup.sh dump nightly` **inside the container** as uid 999 with the canary `BACKUP_DB_PASSWORD`.
      - Assert:
        - the TOC (`pg_restore --list`) names every public table, `audit_events` and `drizzle.__drizzle_migrations`;
        - the file is 0600 and the dir is 0700;
        - the name matches the contract regex;
        - the canary string occurs neither in the dump bytes nor in the script's stdout / stderr;
        - `ps` captured during the dump shows no canary in any argv (AC-24).
      - Restore the documented way: as the owner, connected to `postgres`, run `DROP DATABASE … WITH (FORCE)` and `CREATE DATABASE devdigest OWNER devdigest`, then `pg_restore --no-owner --no-privileges -d devdigest`, then re-run migrations + `apply-grants.mjs`.
      - Assert:
        - per-table row counts are equal;
        - the migrator applies 0 new entries (journal count unchanged);
        - the `devdigest_app` privileges from `information_schema.role_table_grants` equal the expected set (DML on public tables, `SELECT, INSERT` on `audit_events`, nothing on `drizzle`).
      - Failure and rotation: `chmod 0555 /backups`, then `dump nightly` exits 1, no `.tmp-*` remains, and earlier dumps are intact. With `BACKUP_RETAIN=3`, 5 nightly + 2 pre-update dumps → 3 nightly + 2 pre-update remain.
      - Health: a `.first-start` and newest nightly dump backdated by 27 h (`touch -d`) → `health` exits 1; a fresh one → 0.
  - **Module:** deploy + server (tests) · **Type:** backend
  - **Skills to use:** postgresql-table-design, security, drizzle-orm-patterns (running the migrator in the test), typescript-expert
  - **Owned paths:** `deploy/db-grants/backup-role.sql`, `deploy/db-grants/apply-grants.mjs`, `deploy/backup/devdigest-backup.sh`, `server/test/helpers/deploy-pg.ts`, `server/test/backup-role.it.test.ts`, `server/test/backup-restore.it.test.ts`
  - **Depends-on:** none
  - **Risk:** high (privileges, data safety)
  - **Known gotchas:**
    - `grants.sql` runs `REVOKE ALL ON DATABASE … FROM PUBLIC` on every `migrate`. `backup-role.sql` must therefore run **after** it and re-grant `CONNECT` every time. Do not edit `grants.sql`; if a change is truly needed, stop and report.
    - `pg_read_all_data` exists on PG ≥ 14 (we run 16). It grants `USAGE` on all schemas, including `drizzle`, which is required: the runtime role cannot read the journal (spec D-5).
    - `pg_dump` takes `ACCESS SHARE` locks only. Use `-Fc` and do not add `--no-owner` at dump time (it is a restore-time flag).
    - The `pgvector` image's default entrypoint is the postgres server. The compose service overrides `entrypoint` (T1). In tests, run the script with `container.exec(['sh', …], { user: '999' })`.
    - `date -d` (GNU) exists in the Debian-based image. Do not rely on it on the macOS host.
    - Testcontainers already uses `pgvector/pgvector:pg16` (`server/test/global-setup.ts:38`), so no new image pull happens in CI.
    - `apply-grants.mjs` resolves `postgres` via `DEVDIGEST_SERVER_PKG`, so the test must set it.
    - The `server` test runs `deploy/` files through relative paths from `server/`. Use `fileURLToPath(new URL('../../deploy/…', import.meta.url))`.
  - **Acceptance:**
    - `cd server && pnpm vitest run test/backup-role.it.test.ts test/backup-restore.it.test.ts` is green with Docker, and skips cleanly without it (`dockerAvailable()`).
    - `grep -c 'PASSWORD' deploy/db-grants/backup-role.sql` shows no `PASSWORD '<literal>'` (the hard-coded literal check, the same as for `grants.sql`).
    - `git diff main -- deploy/db-grants/grants.sql | wc -l` → `0`.

- **T3 — Update / rollback script and compose wrapper**
  - **Action:**
    - New `deploy/dc.sh` per the contract.
    - New `deploy/update.sh` (bash, `set -euo pipefail`). **First line of `main`:** if not already re-executed, copy itself to `mktemp` and `exec` the copy. A fast-forward rewrites this file while bash is reading it.
      - `--help` text (AC-18): the modes, the exit codes, "migrations are forward-only; rolling back over a migration means restoring the pre-update dump, and everything written since it (reviews, comments, settings, audit events, sessions) is lost".
      - **Preflight (AC-9):**
        - `deploy/.env` exists;
        - `git diff --quiet HEAD` and `git diff --cached --quiet` (tracked files only);
        - the current branch == `DEPLOY_BRANCH`;
        - `mkdir deploy/.state/update.lock.d`, plus a stale-pid check and a `trap` cleanup;
        - the `BACKUP_DIR` exists and is owned by uid 999 (a hint to `sudo install -d -m 0700 -o 999 -g 999 …`).

        Each failure has its own message and exits 1 before any mutation.
      - **Up-to-date (AC-10):** `git fetch --quiet "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"`, then compare `HEAD` with `FETCH_HEAD`. If they are equal, print "already up to date" and exit 0.
      - **Dump + state (AC-11):** run `dc.sh run --rm -T backup dump pre-update <sha7>` and parse `dump: <file>`. On failure, exit 1. Then write `update.env` (`previous_sha`, `current_sha=` the new sha, `pre_update_dump`, `migrations_applied=false`).
      - **Retag current (Q2):** run `docker image tag devdigest-{api,web}:${current tag} …:<prev-sha12>` if that tag does not exist yet.
      - **Fast-forward (AC-12):** `git merge --ff-only FETCH_HEAD`. On failure, exit 1 (HEAD is untouched by `--ff-only`).
      - **Check + build (AC-13):** `bash deploy/check-compose.sh deploy/.env`, then `DEVDIGEST_IMAGE_TAG=<new12> DEVDIGEST_RELEASE=<new> dc.sh build`. On failure, `git reset --hard <prev>` (safe: the tree was clean), restore `update.env`, exit 1. No `up` has run.
      - **Migrations (AC-14):** check `git diff --name-only --diff-filter=A <prev> <new> -- 'server/src/db/migrations/*.sql'`. If it is non-empty, record the DB journal count, then `dc.sh stop api`.
      - **Up:** write `release.env`, then `dc.sh up -d` (no `--build`). After `migrate` exits, re-read the journal count. `migrations_applied` = whether the count increased **or** `migrate` exited non-zero after any increase (spec edge case: a partial migrate counts as applied).
      - **Health + smoke (AC-15):** poll `docker compose ps --format json` until `api` and `web` are `healthy`, or `UPDATE_HEALTH_TIMEOUT` (default 180) passes. Then run `SMOKE_RESOLVE_IP=127.0.0.1 deploy/smoke.sh "$PUBLIC_HOSTNAME"`. On success, print `<prev12> → <new12>` and `smoke: ok`, re-tag `:<new12>` as `:local`, prune, exit 0.
      - **Prune (AC-20):** `docker image rm` every `devdigest-{api,web}:*` tag other than `<new12>`, `<prev12>` and `local`. Then `docker image prune -f` and `docker builder prune -f` (bounded by `--keep-storage` / `--reserved-space` per the installed buildx; detect the supported flag).
      - **Auto-rollback (AC-16):** only when `migrations_applied=false`. Run `git reset --hard <prev>`, write `release.env` with `<prev12>`, and if the `:<prev12>` images are missing, `dc.sh build`. Then `dc.sh up -d`, wait for health again, print `rolled back to <prev12>`, exit 2.
      - **Guided restore (AC-17):** when `migrations_applied=true`. Leave the DB alone. Print the exact commands: stop api / web / backup; restore `<pre_update_dump>` with the T10 runbook commands; `git checkout <prev>`; write `release.env`; `dc.sh up -d`; `deploy/smoke.sh <host>`. Print the data-loss warning. Exit 3.
      - **`rollback` mode (AC-19):** read `update.env`. Compare the DB journal count with the entry count of `git show <previous_sha>:server/src/db/migrations/meta/_journal.json`. If the DB has more, refuse (exit 1), naming `pre_update_dump` and the runbook's restore section. Otherwise check out `previous_sha` (detached is fine; document it), set `release.env`, `up -d` (rebuild only if the images are missing), wait for health + smoke, exit 0.
      - **No secrets (AC-21):** every `docker` / `git` call routes stdout and stderr through the script's own `log` function. `deploy/.env` values are never echoed, and `set -x` is never used.
    - New `deploy/tests/update.test.sh`: builds a scratch git origin (bare) + clone in `mktemp -d`, with a fake `deploy/` tree containing a copy of `update.sh` / `dc.sh`, a stub `check-compose.sh` and a stub `smoke.sh`. A fake `docker` executable on `PATH` records its calls and simulates `ps` health, `run … backup dump` (prints `dump: …`), `exec … psql` (journal count from a file), image inspect and tag. Scenarios:
      - each preflight refusal (4) → distinct message, exit 1, HEAD unchanged, no `docker` call except read-only ones;
      - already up to date → exit 0, no `dump` call, wall time < 30 s;
      - dump failure → exit 1, HEAD unchanged, no `update.env` change;
      - a diverged branch → exit 1, HEAD unchanged;
      - build failure → exit 1, HEAD == prev;
      - a successful update without migrations → no `stop api` call, exit 0, `update.env` holds both shas;
      - with a new migration file → `stop api` precedes `up`;
      - health failure without migration → exit 2, HEAD == prev, `up` called twice;
      - health failure after a migration (the journal count increases) → exit 3, output names the dump and the prev sha, no restore commands executed;
      - `rollback` with the DB ahead → exit 1, naming the dump;
      - canary values in a scratch `deploy/.env` → none appears in the captured stdout / stderr of any scenario;
      - prune keeps exactly `<new>`, `<prev>`, `local`.
  - **Module:** deploy · **Type:** backend
  - **Skills to use:** security
  - **Owned paths:** `deploy/update.sh`, `deploy/dc.sh`, `deploy/tests/update.test.sh`, `deploy/tests/lib/fake-docker.sh`
  - **Depends-on:** none (it codes against the interface contract; T2 / T4 provide the real backup and smoke entry points)
  - **Risk:** high (production availability)
  - **Known gotchas:**
    - Never `source deploy/.env`. Read single keys with `grep -E '^KEY=' | tail -1 | cut -d= -f2-` (secret-free keys only).
    - `docker compose ps --format json` prints NDJSON in Compose ≥ 2.21 and a JSON array before that. Handle both, or require ≥ 2.24 and say so in `--help` (the runbook states the version, AC-2).
    - `git reset --hard` is safe only because preflight proved the tracked tree clean. Untracked files (`deploy/.env`, `.state/`, `backups/`) are ignored, and `.gitignore` covers them.
    - `trap` must release the lock on every exit path, including `exit 2` / `3`.
    - The script must work on bash 4+ (Debian / Ubuntu) and macOS bash 3.2 for the tests. Avoid associative arrays and `${var,,}`.
    - The rtk hook can rewrite `git` output in the dev shell (root INSIGHTS). Run the test harness with `rtk proxy bash deploy/tests/update.test.sh` if results look wrong.
  - **Acceptance:**
    - `bash deploy/tests/update.test.sh` exits 0 and runs every scenario listed above, printing `ok <scenario>` per line.
    - `bash deploy/update.sh --help` exits 0 and contains `forward-only`, the exit-code table, and `restore`.

- **T4 — Smoke script**
  - **Action:**
    - New `deploy/smoke.sh <host>` (bash + curl):
      - **Validation:** exactly one argument; reject `://`, `:`, `/`, `@` and spaces with a usage message (AC-57). Resolve the host first (`getent hosts` → `host` → `dig +short` → curl exit 6), within ≤ 15 s; when `SMOKE_RESOLVE_IP` is set, only validate that it is an IP.
      - **Common curl flags:** `--silent --show-error --max-time 10 --proto '=http,https' --no-location`, never `-k`, `-b` or `-c`, plus `--resolve` pairs when `SMOKE_RESOLVE_IP` is set. Capture with `-o /dev/null -D - -w '%{http_code} %{redirect_url}'`.
      - `http-redirect`: `http://host/` → 301 or 308, with `Location` == `https://host/`.
      - `tls-hsts`: `https://host/` with a valid certificate (curl exit 60 / 35 → FAIL with a cert hint), and the `strict-transport-security` header with `max-age` ≥ 31536000.
      - `ready`: `https://host/api/health/ready` → 200, and the body contains `"ready":true` (read-only string compare).
      - `auth-barrier`: `GET https://host/api/repos` → 401.
      - `google-redirect`: `https://host/api/auth/google/start` → 302 / 303 / 307, with the `Location` host == `accounts.google.com`. If the Location path contains `/sign-in` (the error page), FAIL with the hint `check TRUST_PROXY = proxy IP and that the request reached the API over HTTPS via Caddy`.
      - `web-html`: `https://host/` → 200, with `content-type` starting `text/html`.
      - Exit 0 only if all six are ok. The total budget is a 60 s `SECONDS` guard.
    - New `deploy/tests/smoke.test.sh`: a fake `curl` on `PATH` returning canned status / headers per URL. Scenarios:
      - all ok → exit 0 and 6 ok lines;
      - a 200 instead of the redirect on `http` → FAIL `http-redirect`;
      - a cert error exit 60 → FAIL `tls-hsts`;
      - `max-age=300` → FAIL;
      - ready 503 → FAIL;
      - repos 200 → FAIL;
      - google start → `/sign-in?error=…` → FAIL with the `TRUST_PROXY` hint;
      - web 502 → FAIL;
      - `https://x`, `x:443`, `x/p`, `u@x` → usage error, non-zero;
      - an unresolvable host → DNS error in < 15 s;
      - the fake curl asserts it never received `-k`, `--insecure`, `-b` or `-c`.
  - **Module:** deploy · **Type:** backend
  - **Skills to use:** security
  - **Owned paths:** `deploy/smoke.sh`, `deploy/tests/smoke.test.sh`
  - **Depends-on:** none
  - **Risk:** low
  - **Known gotchas:**
    - The sign-in error path is whatever `server/src/modules/identity/routes.ts:100-105` redirects to. Read it and match that exact path; do not guess.
    - With `--resolve`, the URL host stays the real host, so SNI + the cert check still apply.
    - Caddy answers HTTP→HTTPS with **308** (its default). Accept 301 and 308 as "permanent".
  - **Acceptance:**
    - `bash deploy/tests/smoke.test.sh` exits 0 with every scenario above.
    - `time bash deploy/smoke.sh 'https://x'` exits non-zero in < 1 s and prints `usage`.

- **T5 — Sentry server core (config, port, scrubber, adapter, arch rule)**
  - **Action:**
    - `server/package.json`: add `@sentry/node` with an **exact** version (latest stable major, checked with context7). Install with `npx pnpm@11 add -E @sentry/node` inside `server/`.
    - `server/src/platform/config.ts`:
      - `SENTRY_DSN` (optionalString), `SENTRY_ENVIRONMENT` (optionalString, default `production`), `SENTRY_RELEASE` (optionalString, default `unknown`);
      - expose `sentryDsn`, `sentryEnvironment` and `sentryRelease` on `AppConfig`;
      - no zod refine on the DSN (it can echo the value). Validity is checked by the adapter factory.
    - New `server/src/platform/error-reporting.ts`: `ErrorReporter`, `ReportContext`, `NoopErrorReporter` and `isReportable(err)` (Rec3). No imports beyond `./errors.js`; `RunCancelledError` is matched by `name` shape to avoid a cross-module import.
    - New `server/src/platform/sentry-scrub.ts`: `scrubEvent(event, secrets)`. It:
      - deletes `request.data`, `request.cookies` and `user.{email,username,ip_address}` (keeps `user.id`);
      - allowlists request headers to `user-agent` and `content-type`;
      - drops `request.query_string` and strips the query from `request.url`;
      - drops `breadcrumbs` and `extra` keys whose names match `/(pass|secret|token|key|cookie|auth|session|code|state|dsn)/i`;
      - runs `scrubString` = `redactSecret(s, ...secrets)` plus regexes for `ddg_pat_[A-Za-z0-9_-]+` (`server/src/platform/crypto/tokens.ts:10`), `__Host-ddg_session=[^;\s]+`, `([?&](code|state|id_token)=)[^&\s]+`, `ghp_|gho_|github_pat_|glpat-|sk-[A-Za-z0-9]` token shapes and JWT shapes (`eyJ…\.…\.…`) — over the exception values / messages, `message`, `extra`, `contexts`, `tags`, `transaction`, and `request.url`.
      - It is pure, with a structural event type.
    - New `server/src/adapters/sentry/sentry-reporter.ts`: `createSentryReporter({ dsn, environment, release, log, secrets })`. It:
      - validates the DSN (`new URL`, `https:` or `http:`, a username present, a numeric last path segment). If it is invalid, it logs `log.warn('SENTRY_DSN is malformed — error reporting disabled')` once and returns the Noop;
      - calls `Sentry.init` with Rec5's options, `beforeSend: (e) => scrubEvent(e, secrets())`, `beforeBreadcrumb: () => null`, `maxBreadcrumbs: 0`, and `transportOptions` with bounded queue defaults;
      - `capture(err, ctx)` → `withScope`: `setUser({ id })` when `ctx.userId` is set, tags `route` / `method` / `status` / `job_kind` / `run_id`, then `captureException`;
      - `flush(ms)` → `Sentry.flush(ms)`. Every call is wrapped in try / catch → never throws (AC-42).
    - `server/.dependency-cruiser.cjs`: add the `core-no-sentry` rule (an error rule with a comment stating why). Update the header baseline comment only if the count changes.
    - Tests (hermetic):
      - `server/test/config-sentry.test.ts` — defaults, `''` → unset, the release defaults to `unknown`.
      - `server/test/sentry-scrub.test.ts` — a canary matrix. One event places each canary class in each location: request headers / cookies / data / url / query, breadcrumbs, exception value, message, extra, contexts, tags. The canaries are the Authorization header, the session cookie, a `ddg_pat_…`, GitHub / GitLab / OpenAI tokens, the master key, the Google client secret, an id_token JWT, the OAuth code + state, and DB passwords passed as `secrets`. `JSON.stringify(scrubEvent(e, secrets))` contains none of them. `https://x:TOKEN@host` becomes `https://***@host` (AC-37). `user` keeps only `id` (AC-38).
      - `server/test/sentry-reporter.test.ts` — `vi.mock('@sentry/node')`:
        - with a malformed DSN, `init` is never called and exactly one warn line contains `SENTRY_DSN` and not the value;
        - with a valid DSN, the `init` options have no `tracesSampleRate`, `tracesSampler` or `profilesSampleRate` (or they are `0`); `sendDefaultPii === false`; `includeLocalVariables === false`; no integration named `Replay` / `Http` / `OnUncaughtException` / `OnUnhandledRejection`; and `release` / `environment` pass through (AC-39 / AC-40);
        - `capture` when `captureException` throws → no throw;
        - `flush` resolves even if `Sentry.flush` rejects.
      - `server/test/error-reportable.test.ts` — the `isReportable` table: plain `Error` → true; `AppError` 404 / 409 / 422 → false; `AppError('x', …, 500)` → true; `ExternalServiceError` → false; an SDK-shaped `{ status: 503, headers: {} }` → false; a `RunCancelledError`-named error → false.
  - **Module:** server · **Type:** backend
  - **Skills to use:** onion-architecture, typescript-expert, zod, security, fastify-best-practices (logging rules only)
  - **Owned paths:** `server/package.json`, `server/pnpm-lock.yaml`, `server/src/platform/config.ts`, `server/src/platform/error-reporting.ts`, `server/src/platform/sentry-scrub.ts`, `server/src/adapters/sentry/sentry-reporter.ts`, `server/.dependency-cruiser.cjs`, `server/test/config-sentry.test.ts`, `server/test/sentry-scrub.test.ts`, `server/test/sentry-reporter.test.ts`, `server/test/error-reportable.test.ts`
  - **Depends-on:** none
  - **Risk:** medium (secret leakage if scrubbing is wrong)
  - **Known gotchas:**
    - `server/` uses pnpm v11: run `npx pnpm@11 add -E @sentry/node` inside `server/` (root INSIGHTS). The global pnpm 10 fails with a store mismatch.
    - Config validation must never echo values (see the existing comment in `config.ts` about ZodError issues).
    - `@sentry/node` v8+ initialises OpenTelemetry on `init` unless told not to. Verify `skipOpenTelemetrySetup` / `defaultIntegrations: false` with context7 for the pinned version.
    - Do not import `@sentry/node` anywhere but the adapter. `pnpm arch` `no-concrete-adapter-outside-root` will flag any other importer of `adapters/sentry`.
    - `pnpm arch` needs node 22 (not 23).
  - **Acceptance:**
    - `cd server && pnpm vitest run test/config-sentry.test.ts test/sentry-scrub.test.ts test/sentry-reporter.test.ts test/error-reportable.test.ts` is green.
    - `cd server && pnpm typecheck` is green.
    - `cd server && pnpm arch` → 0 errors.
    - AC-41 probe: `printf "import '@sentry/node';\n" > ../reviewer-core/src/__arch_probe.ts && (pnpm arch; echo exit=$?) ; rm ../reviewer-core/src/__arch_probe.ts` prints `core-no-sentry` and `exit=` non-zero.
    - `git diff main -- ../reviewer-core | wc -l` → `0`.

- **T6 — Run-all with no enabled agent → 409**
  - **Action:**
    - New constant `NO_ENABLED_AGENTS = 'no_enabled_agents'` in `server/src/modules/reviews/constants.ts`.
    - `ReviewService.resolveTargets`: when `opts.all`, `const list = await this.agents.listEnabled(workspaceId)`. If it is empty, throw `new AppError(NO_ENABLED_AGENTS, 'No agent is enabled in this workspace. Create or enable an agent, then run the review again.', 409)`.
    - The route is unchanged: it already calls `resolveTargets` before `runReview`, so no run row is created.
    - New `server/test/reviews-no-enabled-agents.it.test.ts`:
      - a PR fixture with zero agents → `POST /pulls/:id/review {all:true}` → 409, `error.code === 'no_enabled_agents'`, and `select count(*) from agent_runs` unchanged;
      - one disabled agent → still 409;
      - enabling it → 2xx, with runs length 1 (stub the LLM via `ContainerOverrides.llm` as in `reviews.it.test.ts`);
      - `{ agentId: <disabled> }` → 2xx (existing behaviour).
  - **Module:** server · **Type:** backend
  - **Skills to use:** fastify-best-practices, onion-architecture, security
  - **Owned paths:** `server/src/modules/reviews/service.ts`, `server/src/modules/reviews/constants.ts`, `server/test/reviews-no-enabled-agents.it.test.ts`
  - **Depends-on:** none
  - **Risk:** low
  - **Known gotchas:**
    - Copy the fixture setup (PR + repo + agent insert, LLM stub) from `server/test/reviews.it.test.ts`; do not edit that file.
    - The fire-and-forget run must not outlive the test DB (a known flake source, root INSIGHTS): await the run or drain the jobs before `stop()`.
  - **Acceptance:**
    - `cd server && pnpm vitest run test/reviews-no-enabled-agents.it.test.ts` is green.
    - `cd server && pnpm vitest run test/reviews.it.test.ts test/routes-smoke.test.ts` is still green.

- **T7 — Sentry client (opt-in, scrubbed, errors only)**
  - **Action:**
    - `client/package.json`: `pnpm add -E @sentry/browser` (client uses the global pnpm 10).
    - New `client/src/lib/monitoring/config.ts`: reads `process.env.NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (default `production`) and `NEXT_PUBLIC_SENTRY_RELEASE` (default `unknown`). These are static references, so Next inlines them.
    - New `client/src/lib/monitoring/scrub.ts`: pure `scrubEvent`. It:
      - drops `request.cookies` / `data` / `headers` except `user-agent`;
      - drops the query from `request.url`;
      - empties `breadcrumbs`;
      - keeps only `user.id`;
      - regex-masks `ddg_pat_…`, `__Host-ddg_session=…`, `code` / `state` / `id_token` query params, provider token shapes, JWTs and `//user:pass@` in messages, exception values, extra, contexts and tags.
    - New `client/src/lib/monitoring/sentry.ts`:
      - `initMonitoring()`: if the DSN is empty, it returns without importing anything. Otherwise it calls `const Sentry = await import("@sentry/browser")` and then `Sentry.init` with:
        - `defaultIntegrations: false`;
        - `integrations: [globalHandlersIntegration({ onerror: true, onunhandledrejection: true }), linkedErrorsIntegration(), dedupeIntegration()]`;
        - `maxBreadcrumbs: 0`, `sendDefaultPii: false`;
        - no tracing / replay options;
        - `beforeSend`: return `null` when `hint.originalException` is shaped `{ name: 'ApiError' }` (AC-35), else `scrubEvent(event)`.
      - Keeps a module-level `capture` reference.
      - `reportRenderError(err)` → `capture?.(err)` inside try / catch. `setMonitoringUser(id)` → `setUser(id ? { id } : null)`.
    - New `client/src/lib/monitoring/index.ts` (the barrel) and `client/src/lib/monitoring/MonitoringUser.tsx` (`"use client"`, `useSession()` → `setMonitoringUser`, renders `null`).
    - New `client/src/instrumentation-client.ts`: `void initMonitoring();`.
    - `client/src/app/error.tsx` and `client/src/app/global-error.tsx`: call `reportRenderError(error)` in the existing `useEffect` (`global-error.tsx` gains a `useEffect`).
    - `client/src/lib/providers.tsx`: mount `<MonitoringUser />` inside the QueryClient provider.
    - Tests:
      - `client/src/lib/monitoring/scrub.test.ts` — a canary matrix like T5's;
      - `client/src/lib/monitoring/sentry.test.ts` — `vi.mock("@sentry/browser")` with `vi.stubEnv`:
        - an empty DSN → `init` not called and the dynamic import never resolved (mock factory spy not invoked);
        - a DSN set → `init` options have no `tracesSampleRate` / `replaysSessionSampleRate` / `replaysOnErrorSampleRate` (or they are `0`) and no integration named `Replay` / `BrowserTracing`;
        - `beforeSend` with an `ApiError` 500 → `null`;
        - `beforeSend` with a plain `Error` → a scrubbed event;
      - `client/src/app/error.test.tsx` — rendering `RouteError` with an `Error` → `reportRenderError` called once (mocked `@/lib/monitoring`); the same for `GlobalError`.
  - **Module:** client · **Type:** ui
  - **Skills to use:** next-best-practices, react-best-practices, react-testing-library, security, typescript-expert
  - **Owned paths:** `client/package.json`, `client/pnpm-lock.yaml`, `client/src/instrumentation-client.ts`, `client/src/lib/monitoring/**`, `client/src/app/error.tsx`, `client/src/app/global-error.tsx`, `client/src/app/error.test.tsx`, `client/src/lib/providers.tsx`
  - **Depends-on:** none
  - **Risk:** medium
  - **Known gotchas:**
    - Use the next-best-practices skill (user memory).
    - `NEXT_PUBLIC_*` is inlined only through a **static** `process.env.NEXT_PUBLIC_X` member access. No destructuring, no dynamic keys.
    - `instrumentation-client.ts` lives in `src/` (the project uses `src/`). It needs Next ≥ 15.3, and 15.5.19 is installed.
    - `deploy/web.Dockerfile` copies only `client/src` + the listed root files, so no new root-level config file may be added. Everything stays under `src/`.
    - `providers.test.tsx` exists. Keep it green, and mock `useSession` if `MonitoringUser` breaks it.
    - The existing `kick()` in `RunReviewDropdown` has no `catch`. Its rejection is filtered by the `ApiError` rule, but T8 also adds a catch.
  - **Acceptance:**
    - `cd client && pnpm vitest run src/lib/monitoring src/app/error.test.tsx src/lib/providers.test.tsx` is green.
    - `cd client && pnpm typecheck` is green.
    - `cd client && NEXT_PUBLIC_SENTRY_DSN= pnpm build` succeeds.
    - `grep -rlE 'ingest\.(us\.|de\.)?sentry\.io' client/.next/static` → no match (AC-33, static part).

- **T8 — Zero-agents empty states (dropdown + Agents page)**
  - **Action:**
    - `client/messages/en/prReview.json` (`runReview`): add
      - `noEnabledAgents` ("No agent is enabled — enable or create one first.");
      - `noAgentsAdmin` ("No agents yet — create one");
      - `noAgentsMember` ("No agents yet — ask an Admin to create one");
      - `noEnabledAgentsError` ("No agent is enabled. Create or enable an agent, then run the review again.").
    - `client/messages/en/agents.json` (`list`): add `emptyBodyMember` ("Only an Admin can create agents. Ask an Admin in your workspace to add one.").
    - `RunReviewDropdown.tsx`:
      - `const { isAdmin } = useCan()`;
      - while `agents === undefined` (loading), render the agent section with no zero-state item (no flash);
      - the "Run all" item gets `disabled: !hasEnabled` and `disabledReason: t('runReview.noEnabledAgents')` (`DropdownItemDef.disabled` / `disabledReason` already exist in `client/src/vendor/ui/kit/types.ts`), and no `onClick` when disabled;
      - zero agents + Admin → `{ label: t('runReview.noAgentsAdmin'), icon: 'Plus', onClick: () => router.push('/agents?create=1') }`;
      - zero agents + Member → `{ label: t('runReview.noAgentsMember'), icon: 'Info'|'Lock', disabled: true }`;
      - `kick` gains `catch (err)`: if `err` is shaped `{ status: 409, code: NO_ENABLED_AGENTS }`, call `useToast()` with `t('runReview.noEnabledAgentsError')`; otherwise rethrow.
      - Add `NO_ENABLED_AGENTS = "no_enabled_agents"` to `constants.ts`.
    - `AgentsListView.tsx`:
      - read `create` with `useQueryParam` (`src/lib/hooks/use-query-param.ts`). When it is `"1"` and `isAdmin`, open `CreateAgentModal` once and clear the param (replace, no history entry). A Member ignores it.
      - The Member empty state uses `body={t('list.emptyBodyMember')}` with no CTA. The Admin state is unchanged.
    - `client/src/app/agents/page.tsx`: wrap the view in `<Suspense>` only if `useQueryParam` uses `useSearchParams` (`next build` fails otherwise).
    - Tests:
      - extend `RunReviewDropdown.test.tsx` with per-test agent mocks:
        - (a) one enabled agent → clicking "Run all" calls `mutateAsync` with `{all:true}`;
        - (b) only disabled agents → the "Run all" item has `aria-disabled="true"`, the hint text is present, and a click → `mutateAsync` is not called (AC-58);
        - (c) zero agents + Admin → clicking "No agents yet — create one" → `push('/agents?create=1')`;
        - (d) zero agents + Member → the item is `aria-disabled`, and a click → no `push` (AC-59);
        - (e) `mutateAsync` rejecting with a 409 `no_enabled_agents` → a toast with the localized message;
        - (f) the component source has no `"No agents yet"` literal (read the file and assert; AC-59 "no hard-coded English").
      - extend `AgentsListView.test.tsx`: an empty list + Member → the `emptyBodyMember` text and no CTA button; an empty list + Admin → the CTA unchanged; `?create=1` + Admin → the create modal dialog is open; `?create=1` + Member → no dialog.
  - **Module:** client · **Type:** ui
  - **Skills to use:** react-best-practices, react-testing-library, next-best-practices
  - **Owned paths:** `client/src/app/repos/[repoId]/pulls/[number]/_components/RunReviewDropdown/{RunReviewDropdown.tsx,RunReviewDropdown.test.tsx,constants.ts}`, `client/src/app/agents/_components/AgentsListView/{AgentsListView.tsx,AgentsListView.test.tsx}`, `client/src/app/agents/page.tsx`, `client/messages/en/prReview.json`, `client/messages/en/agents.json`
  - **Depends-on:** none (the 409 shape is fixed by the spec; T6 implements it)
  - **Risk:** low
  - **Known gotchas:**
    - Use the next-best-practices skill (user memory).
    - Mock `@/lib/hooks/permissions` (`useCan`) and `@/lib/toast` in the tests, the way the existing tests mock `useAgents`.
    - The messages JSON is imported directly by the tests: keep it valid JSON with the key order stable.
    - `ApiError` is matched by shape (`status` / `code`), not `instanceof`, so it stays consistent with the server's ZodError-by-shape policy.
  - **Acceptance:**
    - `cd client && pnpm vitest run 'src/app/repos/[repoId]/pulls/[number]/_components/RunReviewDropdown' src/app/agents/_components/AgentsListView` is green, with scenarios (a)–(f) and the 4 AgentsListView cases.
    - `cd client && pnpm typecheck && pnpm build` is green.

### Phase 2 — Wiring and runbook (wave 2: T9, T10 run concurrently)

- **T9 — Sentry server wiring (capture points, process handlers, flush)**
  - **Action:**
    - `server/src/platform/container.ts`:
      - `ContainerOverrides.errorReporter?: ErrorReporter`;
      - a lazy `get errorReporter()` → the override, else Noop when `!config.sentryDsn || config.nodeEnv === 'test'`, else `createSentryReporter({ dsn, environment, release, log: this.log, secrets: () => [config.masterKey, config.googleClientSecret, …] })` (the static secrets known to config + DB URL passwords). Use the actual field names from `config.ts`;
      - pass `reporter` into `new JobRunner(…)` and into `new PublishRunner({ …, reporter })`;
      - expose `get errorReporterActive(): boolean`.
    - `server/src/platform/jobs.ts`: an optional `reporter?: ErrorReporter` in `JobRunnerOptions`. `reportFailure` additionally calls `reporter.capture(err, { jobKind: kind })` when `isReportable(err)`, once per job (the final failure, after retries), inside the existing try / catch.
    - `server/src/modules/publish/runner.ts`: an optional `reporter` dep. The `.catch` captures with `{ jobKind: 'publish' }` when `isReportable`.
    - `server/src/modules/reviews/run-executor.ts`: in the run-level `catch` at the failure branch (non-cancel), `this.container.errorReporter.capture(err, { jobKind: 'review_run', runId })` when `isReportable(err)`.
    - `server/src/app.ts`:
      - in the final generic branch of `setErrorHandler`, when `status >= 500 && isReportable(err)`, call `container.errorReporter.capture(err, { userId: req.principal?.userId, route: req.routeOptions.url, method: req.method, status })`. Use the real principal field name;
      - the `onClose` hook calls `await container.errorReporter.flush(2000)`, registered so it runs within the existing shutdown race.
    - `server/src/server.ts`: after `buildApp`, if `app.container.errorReporterActive`, install `process.on('uncaughtException', …)` and `process.on('unhandledRejection', …)`. Each does capture → `await flush(2000)` → `app.log.fatal(redacted message)` → `process.exit(1)`. When inactive, install nothing (today's behaviour, AC-32).
    - Tests (hermetic, a recording fake reporter through `ContainerOverrides`):
      - `server/test/sentry-capture.test.ts` — `buildApp({ overrides: { errorReporter: fake } })`. Register a test-only route that throws a plain `Error` before `ready()`, then call it → exactly 1 capture with `status: 500`, the route template and `method`. A 404 unknown route, a 422 invalid body, an `AppError` 409 and a google-mode 401 → 0 captures (use the existing google-mode test harness, e.g. from `auth-guard-matrix.test.ts`). A signed-in principal → `ctx.userId` is set and nothing else identifying is passed. `app.close()` calls `flush` with `≤ 2000`.
      - `server/test/job-runner-reporting.test.ts` — a failing handler with `retries: 2` → exactly 1 capture after the final failure, with `jobKind`. An `AppError` 404 handler → 0. A throwing `reporter.capture` → no unhandled rejection.
      - `server/test/sentry-inactive.test.ts` — with no overrides and `config.sentryDsn` unset → `errorReporterActive === false`, and `process.listenerCount('uncaughtException')` is unchanged after `buildApp` (AC-32).
      - `server/test/publish-runner.test.ts` (existing) — still green. Add one case to a **new** file `server/test/publish-runner-reporting.test.ts` (an internal error → 1 capture; an `ExternalServiceError` → 0).
  - **Module:** server · **Type:** backend
  - **Skills to use:** onion-architecture, fastify-best-practices, typescript-expert, security
  - **Owned paths:** `server/src/platform/container.ts`, `server/src/platform/jobs.ts`, `server/src/modules/publish/runner.ts`, `server/src/modules/reviews/run-executor.ts`, `server/src/app.ts`, `server/src/server.ts`, `server/test/sentry-capture.test.ts`, `server/test/job-runner-reporting.test.ts`, `server/test/sentry-inactive.test.ts`, `server/test/publish-runner-reporting.test.ts`
  - **Depends-on:** T5
  - **Risk:** medium (hot bootstrap files, crash semantics)
  - **Known gotchas:**
    - `reportFailure` runs from `done.catch`, so it must stay non-throwing (see the comment in `jobs.ts`).
    - Do not change the HTTP response bodies (the existing 5xx tests assert `internal_error` / `Internal error`).
    - `onClose` ordering: the publish drain already races a grace timer. Put the flush **after** the drains, and keep the total within the existing shutdown + 2 s (AC-43).
    - `req.routeOptions.url` is the template (`/pulls/:id/review`), not the raw URL. Never pass `req.url`: it can carry `code` / `state`.
    - `run-executor.ts` already depends on the container (a known `no-container-inward` warning). Do not add new container imports elsewhere, so the warning count does not grow.
    - The hermetic test must not hit Postgres. Use an existing hermetic `buildApp` pattern (e.g. `routes-smoke.test.ts`).
    - T6 owns `reviews/service.ts` in wave 1. Do not touch it here.
  - **Acceptance:**
    - `cd server && pnpm vitest run test/sentry-capture.test.ts test/job-runner-reporting.test.ts test/sentry-inactive.test.ts test/publish-runner-reporting.test.ts test/publish-runner.test.ts test/job-runner.test.ts test/routes-smoke.test.ts` is green.
    - `cd server && pnpm typecheck && pnpm test` is green (full suite, Docker on; AC-32: no new config needed).
    - `cd server && pnpm arch` → 0 errors, warnings ≤ the main baseline recorded in T11.

- **T10 — Deployment runbook + README section**
  - **Action:**
    - New `docs/deployment.md`. Its sections are in the AC-1 order: Prerequisites · DNS · Google OAuth client · Fill `deploy/.env` · Static check · First start · First Admin · Provider & LLM keys · Create review agents · Connect MCP · Smoke check · Update (with "Adopting this on an existing deployment (one time)", Q3) · Rollback · Backup & restore · Disk & logs · Sentry · Troubleshooting · Settings reference. Content:
      - **Prerequisites (AC-2):** min 2 vCPU / 4 GiB + 2 GiB swap / 40 GB; recommended 4 / 8 / 80; Ubuntu 22.04 / 24.04 or Debian 12; Docker Engine ≥ 24 and Compose plugin ≥ 2.24; git; Node.js 22 (Q4); inbound 80 / 443 TCP + 443 UDP; DNS A / AAAA before first start; a read-only GitHub deploy key + `DEPLOY_BRANCH` (A11); "write access to the deploy branch = deploy access to the VM".
      - **Google OAuth (AC-3):** Internal consent screen, a Web application client, the exact redirect URI string from `.env.example`, and the field → setting mapping.
      - **Secrets (AC-4):** `openssl rand -hex 24` for each of the 3 DB passwords, `openssl rand -base64 32` for the master key, `chmod 600 deploy/.env`, store the 4 values off-VM, and the dump-without-master-key warning.
      - **First start (AC-5):**
        1. `sudo install -d -m 0700 -o 999 -g 999 deploy/backups`;
        2. `bash deploy/check-compose.sh deploy/.env`;
        3. `deploy/dc.sh up -d --build`;
        4. smoke from a workstation;
        5. the Admin signs in;
        6. keys or `secrets:import`;
        7. create agents manually ("production starts with zero agents and no demo data");
        8. connect a repo.
      - **MCP (AC-6):** Settings → API tokens, `DEVDIGEST_API_BASE=https://<host>/api`, `DEVDIGEST_API_TOKEN`, never commit the token, and a link to `specs/2026-11-03-admin-token-revocation.md`.
      - **Update / rollback (AC-18):** `deploy/update.sh` with its exit codes, forward-only migrations + the data-loss statement, the `rollback` mode, diff `.env.example` on update, update outside working hours, and the hairpin note (`SMOKE_RESOLVE_IP`).
      - **Restore (AC-29):** the exact commands:
        1. `deploy/dc.sh stop api web backup`;
        2. `docker compose exec -T postgres psql -U devdigest -d postgres -c 'DROP DATABASE devdigest WITH (FORCE)' -c 'CREATE DATABASE devdigest OWNER devdigest'`;
        3. `docker compose exec -T postgres pg_restore -U devdigest -d devdigest --no-owner --no-privileges < deploy/backups/<file>` (sudo to read);
        4. `deploy/dc.sh up -d`;
        5. the smoke check.

        Plus the same-`SECRETS_MASTER_KEY` warning. These are the same commands T2's test follows. Reconcile with T3's printed AC-17 commands, and if they differ, report it, do not edit `update.sh`.
      - **Backups:** a warning block (AC-31).
      - **Disk & logs (AC-48):** `docker system df -v`, `docker volume ls` + `du` on the volume mountpoints, `du -sh deploy/backups`, the log bound; the manual clone deletion (find the clone path under the `clones` volume for a removed repo, the path layout per `server/src/adapters/git/simple-git.ts`; `docker compose exec api rm -rf /data/clones/<…>` only after confirming the repo is removed); act at 80 %.
      - **Sentry (AC-44, A6, A7):** `SENTRY_DSN` (runtime, sensitive), `SENTRY_WEB_DSN` (build-time, public, needs a rebuild), `SENTRY_ENVIRONMENT`, the release = the deployed sha via `update.sh`, no source maps, errors only, the hosting-region policy note, and the CSP `connect-src` caveat.
      - **Troubleshooting (AC-7):** the 9 rows of symptom / cause / fix (plus the Let's Encrypt rate limit).
      - **Settings reference (AC-8):** one row per `.env.example` setting, in the ``| `NAME` |`` format from the interface contract.
      - Diagrams: one Mermaid flowchart of the update flow and one of the topology (mermaid-diagram skill).
    - `README.md`: a new section `## Deploying for a team (server mode)` (after "Quick start") with 3–5 lines and a link to `docs/deployment.md`.
  - **Module:** docs · **Type:** backend (docs)
  - **Skills to use:** mermaid-diagram, security (the doc-writer agent fits: it writes only `docs/**` and `README.md`)
  - **Owned paths:** `docs/deployment.md`, `README.md`
  - **Depends-on:** T1, T2, T3, T4, T5, T7
  - **Risk:** low
  - **Known gotchas:**
    - Every command must be copied from the real scripts / compose of T1–T4. Run `--help` and read the files, never paraphrase flags.
    - Never quote a real value from `deploy/.env` (never read it).
    - The sign-in error path and the "No admin" / "another instance" log strings must be grepped from `server/src` (`modules/identity/routes.ts`, the boot code), not invented.
  - **Acceptance:**
    - `bash deploy/check-compose.sh` passes, including the AC-8 runbook ↔ `.env.example` check (no "runbook absent" note).
    - `rtk proxy grep -c '^## ' docs/deployment.md` ≥ 18. A scripted order check: `rtk proxy grep '^## ' docs/deployment.md` matches the AC-1 order.
    - `rtk proxy grep -F 'https://<PUBLIC_HOSTNAME>/api/auth/google/callback' docs/deployment.md deploy/.env.example` matches in both files.
    - `rtk proxy grep -n 'deployment.md' README.md` → one link, under `## Deploying for a team (server mode)`.
    - The troubleshooting table has ≥ 9 rows. The words `forward-only`, `SECRETS_MASTER_KEY`, `local only` and `80 %` each appear.

### Phase 3 — Verification gate (wave 3)

- **T11 — Verification gate (no new code)**
  - **Action:**
    - **Before the merge commits land** (or on `main` in a worktree), record `pnpm arch` on `main`: warnings = W0, errors = 0.
    - Run the Final verification matrix below. Route each failure back to the owning task, and fix nothing outside an owning task.
    - Then run the manual VM drill checklist (by the user, on a minimum-size VM) and record the measured NFRs:
      - a fresh install per the runbook → the smoke check is all ok;
      - an update without migrations: downtime ≤ 120 s, measured with `while curl …/api/health/ready; do …; done`;
      - a forced API boot failure → auto-rollback ≤ 5 min, exit 2;
      - an update adding a dummy migration on a scratch branch → `api` stopped before `migrate`;
      - a forced failure → exit 3 with the printed commands, then follow them → healthy;
      - the nightly dump appears at `BACKUP_SCHEDULE`; `/health/ready` p95 < 200 ms during a dump on a 2 GB DB; the dump finishes in ≤ 15 min;
      - `docker inspect` shows the log config and the limits;
      - an OOM of `api` (`docker update --memory 64m`) → restart, and the orphaned run is reaped as failed;
      - a Sentry test DSN → an API 5xx event and a web render-error event, both with `release` = the deployed sha, `user.id` only, and no canary found;
      - a black-hole DSN (`https://k@10.255.255.1/1`) → `/health/ready` p95 delta < 5 ms;
      - a malformed DSN → one boot warning;
      - SIGTERM with a queued event → exit within the shutdown budget + 2 s;
      - MCP via a personal token → `list-agents` returns the workspace agents (AC-6).
  - **Module:** server, client, deploy, docs · **Type:** backend
  - **Skills to use:** onion-architecture, security
  - **Owned paths:** none
  - **Depends-on:** T6, T8, T9, T10
  - **Risk:** low
  - **Known gotchas:** `pnpm arch` needs node 22 (dependency-cruiser refuses odd releases). Use `rtk proxy` for lint / grep output (root INSIGHTS).
  - **Acceptance:** every matrix command exits as stated. The VM drill results are pasted into the PR description.

## Testing strategy
- **deploy (bash, no Docker daemon needed):**
  - `bash deploy/tests/check-compose.test.sh` (T1, mutation harness);
  - `bash deploy/tests/update.test.sh` (T3, fake `docker` + scratch git remotes);
  - `bash deploy/tests/smoke.test.sh` (T4, fake `curl`);
  - `bash deploy/check-compose.sh`.
- **server, hermetic** (`cd server && pnpm vitest run <file>`): `config-sentry`, `sentry-scrub`,
  `sentry-reporter`, `error-reportable` (T5); `sentry-capture`, `job-runner-reporting`,
  `sentry-inactive`, `publish-runner-reporting` (T9).
- **server, Postgres** (`*.it.test.ts`):
  - `backup-role`, `backup-restore` (T2; a **dedicated** pgvector:pg16 container, because roles are cluster-wide);
  - `reviews-no-enabled-agents` (T6; the shared broker cluster).
- **client** (`cd client && pnpm test`): `monitoring/scrub`, `monitoring/sentry`, `app/error` (T7);
  the extended `RunReviewDropdown` and `AgentsListView` tests (T8).
- **regression:** the full server suite, the full client suite, `./scripts/e2e.sh` (local mode, no flow
  edits), reviewer-core unchanged, `mcp` unchanged.
- **manual:** the T11 VM drill (NFRs and the end-to-end observables that need a real host, cert,
  Google and Sentry).
- **security carried by tests:**
  - the canary matrices (T5, T7);
  - canary `deploy/.env` → no leak in update output (T3);
  - no canary in the dump, argv or logs (T2);
  - the backup role is read-only (T2);
  - check-compose mutations (T1);
  - no `-k` / cookies in smoke (T4).

## Final verification matrix

```
# baseline (on main, before merge):  cd server && pnpm arch   → record W0 warnings, 0 errors
cd server && pnpm typecheck && pnpm test                                  # Docker on; includes backup-*.it + reviews-no-enabled-agents.it
cd server && pnpm arch                                                    # node 22; 0 errors; warnings <= W0
cd server && printf "import '@sentry/node';\n" > ../reviewer-core/src/__arch_probe.ts; pnpm arch; echo "exit=$?"; rm ../reviewer-core/src/__arch_probe.ts   # exit != 0, names core-no-sentry (AC-41)
cd client && pnpm typecheck && rtk proxy pnpm lint && pnpm test
cd client && NEXT_PUBLIC_SENTRY_DSN= pnpm build && ! grep -rlE 'ingest\.(us\.|de\.)?sentry\.io' .next/static   # AC-33 static
cd reviewer-core && pnpm typecheck && pnpm test
git diff main --stat -- reviewer-core mcp server/src/db/bootstrap.ts server/src/db/migrations | wc -l          # 0
git diff main --stat -- server/src/vendor/shared client/src/vendor/shared | wc -l                              # 0 (Rec1)
node scripts/check-shared-sync.mjs                                                                              # in sync
git diff main -- deploy/db-grants/grants.sql | wc -l                                                            # 0
bash deploy/check-compose.sh                                                                                    # all ok incl. AC-8 runbook check
bash deploy/tests/check-compose.test.sh && bash deploy/tests/update.test.sh && bash deploy/tests/smoke.test.sh  # all ok
bash deploy/update.sh --help | grep -q forward-only                                                             # AC-18
docker compose -f deploy/compose.yml --env-file deploy/.env.example build                                      # both images build; release=unknown (AC-39)
./scripts/e2e.sh                                                                                                # local-mode regression, no flow edits
git diff main --stat -- e2e/specs | wc -l                                                                       # 0
command -v shellcheck && shellcheck deploy/*.sh deploy/backup/*.sh deploy/tests/*.sh                            # if available; 0 errors
git status --porcelain deploy/backups deploy/.state | wc -l                                                     # 0 (AC-27 git-ignored)
```

## Risks & mitigations
- **Every update auto-rolls back because of hairpin NAT.** → `SMOKE_RESOLVE_IP=127.0.0.1` in
  `update.sh` (Q1). The runbook documents the workstation run.
- **`update.sh` is rewritten by its own fast-forward mid-run.** → It re-execs from a temp copy on
  start (T3 gotcha + a test scenario that changes `update.sh` in the new commit).
- **The operator bypasses `dc.sh`, and plain compose runs stale `:local` images.** → `update.sh`
  re-tags the current images as `:local` on success (Q2), so plain compose runs the current version.
  Only the release tag degrades to `unknown`.
- **First adoption cannot use `update.sh`.** → The runbook's one-time adoption subsection (Q3). T11
  drills it.
- **Backup dir permissions** (a bind mount created by Docker as root:root 0755 → uid 999 cannot write).
  → Runbook `install -d -o 999`, the `update.sh` preflight check, and the `daemon` startup log line
  with a clear error.
- **The backup role leaks write rights.** → `pg_read_all_data` only, plus
  `default_transaction_read_only`, the fail-closed membership / ownership checks, and an it-test of
  every write / DDL class (T2).
- **A secret in a Sentry event.** → Scrub as the first line (allowlist headers, no bodies, no
  breadcrumbs, no local variables) plus `redactSecret` + regexes as the second, canary matrices on
  both sides, `user.id` only, and route templates instead of raw URLs (T5, T7, T9).
- **Sentry changes crash semantics or adds latency.** → Process handlers only when active,
  capture → flush ≤ 2 s → exit 1 as today; capture is synchronous enqueue; latency measured in the
  T11 drill.
- **The `@sentry/node` SDK drags in OpenTelemetry auto-instrumentation.** → `defaultIntegrations: false`
  + `skipOpenTelemetrySetup`, asserted by `sentry-reporter.test.ts` (T5).
- **A provider outage floods Sentry.** → `isReportable` excludes provider / SDK errors (A9, Rec3).
- **The image build OOMs on a 4 GiB VM.** → 2 GiB swap in the prerequisites. The build happens while
  the old containers serve (AC-13), and a failure rolls the checkout back.
- **Shared-file collisions between parallel agents.** → The hot-file table gives each file one owner,
  and the interface contract fixes every cross-task name up front.
- **Restore commands drift between the runbook, the T3 printed commands and the T2 test.** → T10 must
  reconcile them, and the T11 drill follows the runbook literally.

## Requirement → task traceability (AC → tasks)

| AC | Tasks | AC | Tasks | AC | Tasks |
|---|---|---|---|---|---|
| AC-1 | T10 | AC-22 | T1, T2 | AC-43 | T9, T11 |
| AC-2 | T10 | AC-23 | T2, T1 | AC-44 | T1, T10 |
| AC-3 | T10 | AC-24 | T2 | AC-45 | T1, T11 |
| AC-4 | T10 | AC-25 | T2 | AC-46 | T1, T11 |
| AC-5 | T10, T8 | AC-26 | T2 | AC-47 | T1, T11 |
| AC-6 | T10, T11 | AC-27 | T1, T2 | AC-48 | T10 |
| AC-7 | T10 | AC-28 | T2, T1 | AC-49 | T1 |
| AC-8 | T1, T10 | AC-29 | T10, T2 | AC-50 | T4 |
| AC-9 | T3 | AC-30 | T2 | AC-51 | T4 |
| AC-10 | T3 | AC-31 | T10 | AC-52 | T4 |
| AC-11 | T3, T2 | AC-32 | T5, T9 | AC-53 | T4 |
| AC-12 | T3 | AC-33 | T7, T1 | AC-54 | T4 |
| AC-13 | T3 | AC-34 | T5, T9 | AC-55 | T4 |
| AC-14 | T3 | AC-35 | T7 | AC-56 | T4 |
| AC-15 | T3, T4 | AC-36 | T5, T7 | AC-57 | T4 |
| AC-16 | T3, T1 | AC-37 | T5 | AC-58 | T8 |
| AC-17 | T3, T10 | AC-38 | T5, T9, T7 | AC-59 | T8 |
| AC-18 | T3, T10 | AC-39 | T1, T3, T5, T7 | AC-60 | T8 |
| AC-19 | T3 | AC-40 | T5, T7 | AC-61 | T6 |
| AC-20 | T3 | AC-41 | T5 | | |
| AC-21 | T3 | AC-42 | T5, T9, T11 | | |

Gap → task: G-1 → T10; G-2 → T3; G-3 → T1, T2; G-4 → T5, T7, T9; G-5 → T1; G-6 → T10 (doc only,
A5); G-7 → T4; G-8 → T6, T8, T10; G-9 → T3.
NFRs: VM size / limits → T1, T10, T11; logs ≤ 50 MB → T1; downtime / rollback budgets → T3, T11;
smoke timeouts → T4; dump time + p95 → T2, T11; Sentry overhead → T5, T11; no-secret-anywhere → T1,
T2, T3, T5, T7.

## Red-flags check
- [x] Every requirement maps to a task: 61/61 ACs, 9/9 gaps and every NFR (tables above).
- [x] No specification was authored or edited. `specs/2026-11-06-production-readiness.md` was taken as
      input. Divergences and extensions are recorded as Q1–Q6 / Rec1–Rec7, and the spec defaults as A1–A11.
- [x] The execution mode is recorded (multi-agent, 3 waves) and the plan is shaped for it (the
      interface contract, the hot-file owners, the concurrency lists). It is still runnable top to
      bottom by one agent.
- [x] Dependencies form a DAG: wave 1 (T1–T8, no deps) → T9 (T5) and T10 (T1–T5, T7) → T11 (T6, T8,
      T9, T10). There are no back edges.
- [x] (multi-agent) Concurrent tasks have non-overlapping Owned paths:
  - wave 1 splits the deploy files four ways (T1 / T2 / T3 / T4), the server files two ways (T5 platform + adapter + deps; T6 `reviews/service.ts` + constants) and the client files two ways (T7 monitoring + error pages + providers; T8 dropdown + agents + messages), with distinct test files throughout;
  - wave 2: T9 (server bootstrap files) vs T10 (`docs/`, `README.md`).
- [x] Every Acceptance is a command, a named test file with named scenarios, or a measured drill
      observable.
- [x] No edits to existing shared contracts. No new shared files either (Rec1). `grants.sql`, applied
      migrations, `bootstrap.ts`, reviewer-core and mcp are asserted unchanged in the matrix.
