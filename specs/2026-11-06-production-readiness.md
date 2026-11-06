# Spec: Production readiness for the single-VM google-mode deployment   |   Spec ID: SPEC-2026-11-06-production-readiness   |   Status: draft
Supersedes: none. **Extends** [`2026-10-19-multi-user-server.md`](./2026-10-19-multi-user-server.md),
called **the base spec** below. No base rule is replaced:

| Base item | What happens to it |
|---|---|
| Base **AC-60** (one Compose definition) | Extended. The definition gains a `backup` service, log rotation and resource limits on every service (AC-22, AC-45, AC-46). |
| Base **AC-61** (migrations as an explicit step) | Unchanged. The update procedure orders the step and stops the API first when needed (AC-14). |
| Base **AC-62 / AC-65 / AC-66** (HTTPS, one origin, proxy) | Unchanged. They are now checked after each deploy by the smoke script (AC-50 to AC-57). |
| Base **AC-5** (one API instance per DB) | Unchanged. The update and restore procedures rely on it: they never start a second API. |
| [`2026-11-03-admin-token-revocation.md`](./2026-11-03-admin-token-revocation.md) | Out of scope. The runbook links to it for "a member's token leaked". |

Scope: cross-module.
- **deploy** (`deploy/`): a backup service, an update script, a smoke script, log rotation,
  resource limits, new settings in `.env.example`, more checks in `check-compose.sh`.
- **docs**: a new deployment runbook `docs/deployment.md`, linked from `README.md`.
- **server**: optional Sentry error reporting. It also returns an explicit error for "run all
  enabled agents" when no agent is enabled.
- **client**: optional Sentry error reporting. It also adds clear zero-agents states in the
  Run-review dropdown and on the Agents page.
- **reviewer-core, `@devdigest/shared` existing contracts, mcp, `db:bootstrap`**: unchanged.

## Problem & why
Server mode is built and merged (base spec): Google sign-in, roles, encrypted secrets,
personal API tokens and audit. `deploy/compose.yml` runs it behind Caddy with least-privilege
DB roles. Still, the team cannot run it on a real VM and keep it running safely. An audit
of the repo on 2026-11-06 found these gaps:

| # | Gap | Evidence |
|---|---|---|
| G-1 | No deployment / operations guide. Server mode is explained only by the comments in compose and `.env.example`. The README has no deploy section. | `README.md` headings (Quick start, Manual steps, Troubleshooting are all local mode); `deploy/compose.yml:1-48`; `deploy/.env.example` |
| G-2 | No update procedure. There is no pre-update backup, no record of the previous version and no rollback. Migrations are forward-only, so a bad update cannot be undone by `git checkout`. | `deploy/compose.yml:3-4` (only `up -d --build`) |
| G-3 | No backups at all. If the `pgdata` volume is lost, all reviews, settings, encrypted secrets and the audit trail are lost. | `deploy/compose.yml:216-220` (volumes only, no backup service) |
| G-4 | No error monitoring. A 5xx is only visible in `docker logs`. Adapter error messages may contain credentials, so any reporter must redact them. | `server/src/app.ts:442-453`; no Sentry dependency in `server/package.json` or `client/package.json` |
| G-5 | No Docker log rotation and no memory/CPU limits. The default `json-file` logs grow without bound. One runaway container (a large clone, an index, a Next build) can starve Postgres. | `deploy/compose.yml` (no `logging:`, no `deploy.resources`) |
| G-6 | Clone disk usage grows without bound. There is one shallow clone per connected repo, but **removing a repo never deletes its clone**. GitHub PR heads are also fetched without a depth limit. | `server/src/modules/repos/service.ts:237-240`; `server/src/adapters/git/simple-git.ts:343-346` |
| G-7 | No post-deploy check. A wrong `TRUST_PROXY`, DNS or certificate problem shows up only when the first user tries to sign in. | `server/src/modules/identity/routes.ts:100-105` (sign-in silently redirects to the error page over non-HTTPS) |
| G-8 | A production workspace starts with **zero agents** (`db:bootstrap` creates none). With no enabled agents, "Run all enabled agents" stays clickable and quietly does nothing: the server answers 200 with no runs. The zero-agents item is hard-coded English. A Member sees "Create one to start reviewing" but has no way to do it. | `server/src/db/bootstrap.ts:11-13`; `client/src/app/repos/[repoId]/pulls/[number]/_components/RunReviewDropdown/RunReviewDropdown.tsx:61,72-77`; `server/src/modules/reviews/service.ts:59`; `client/src/app/agents/_components/AgentsListView/AgentsListView.tsx:98-104`; `client/messages/en/agents.json:17` |
| G-9 | During `up -d --build`, migrations run while the **old** API is still serving. Old code runs against the new schema until `api` is recreated. | `deploy/db-grants/grants.sql` step 5 comment ("an already-running api … keeps serving"); `deploy/compose.yml:137-143` |

### Verified in code (no gap)
- **`/health/ready` checks the DB.** It runs `select 1` and answers 503 `{ready:false}` when
  the DB is down (`server/src/app.ts:385-395`). It is public (`server/src/platform/auth/route-policy.ts:145`).
- **The web app makes no server-side calls to the API.** Every call goes from the browser
  through `client/src/lib/api.ts` (the base URL is inlined at build time,
  `client/next.config.mjs:8-10`), plus raw `EventSource` calls. There is no `middleware.ts`
  and no `next/headers` use. **No internal API URL is needed in production.**
- **`PUBLIC_HOSTNAME` gives the right origin, cookie and CORS behaviour behind Caddy.**
  The public origin is `https://<host>` (`server/src/platform/config.ts:297-337`). CORS is
  limited to it (`server/src/app.ts:351`). Cookies are always `Secure` and `HttpOnly`
  (`server/src/modules/identity/helpers.ts:116`). Sign-in refuses non-HTTPS requests, which
  depends on `TRUST_PROXY` = the proxy IP (`deploy/compose.yml:79`). So it works as long as
  the proxy chain is correct. The smoke check (AC-55) catches the case where it is not.
- **The Caddy CSP sets no `connect-src` / `default-src`.** It sets only `frame-ancestors`,
  `base-uri`, `object-src` and `form-action` (`deploy/Caddyfile:31`), so browser requests
  to a Sentry ingest host are not blocked today.

## Goals / Non-goals
- Goal: an operator who has never seen the repo can follow one runbook from an empty VM to
  "the team signs in and runs its first review".
- Goal: one update command takes a backup first, records the previous version, applies the
  update, and either confirms it is healthy or rolls back / gives exact rollback steps.
- Goal: nightly local DB dumps with rotation, made by a read-only role. Restore is
  documented and covered by a test.
- Goal: optional Sentry error reporting for API and web, with strict scrubbing. It does
  nothing when not configured.
- Goal: bounded container logs, memory/CPU limits on every service, and a clear statement
  of what else grows on disk.
- Goal: a credential-free smoke check that proves HTTPS, readiness, the auth barrier and the
  Google redirect.
- Goal: a workspace with zero agents points users to "create an agent" (Admin) or "ask an
  Admin" (Member). It never quietly does nothing.
- Non-goal: horizontal scale-out, more than one API replica, high availability, Kubernetes.
- Non-goal: a CI image build, an image registry, or auto-deploy. Updates are built on the VM (D-1).
- Non-goal: off-site / S3 / cross-region backups, point-in-time recovery (WAL archiving),
  encrypting dumps. **Accepted risk: losing the VM or its disk loses every backup** (AC-31).
- Non-goal: alerting or paging beyond Sentry's own notifications. No uptime monitor, no metrics stack.
- Non-goal: Sentry performance tracing, profiling, Session Replay, source-map upload (Open questions).
- Non-goal: self-managed GitLab, new auth providers, SSO changes.
- Non-goal: changing existing `@devdigest/shared` contracts, changing reviewer-core, or
  changing `db:bootstrap` (no built-in agents in production, D-4).
- Non-goal: deleting clones automatically when a repo is removed (G-6). It is documented
  with a manual procedure. The code fix is an Open question.
- Non-goal: Admin token revocation (its own spec, linked above).

## User stories
- US-1: As the operator, I want a step-by-step runbook from an empty VM to a working team
  deployment, so I don't have to reverse-engineer compose comments.
- US-2: As the operator, I want one safe update command, so a deploy never leaves the team
  with a broken app and no way back.
- US-3: As the operator, I want a documented rollback, including the case where the update
  already migrated the DB, so I know exactly what data I would lose.
- US-4: As the operator, I want nightly backups and a restore procedure that has been tested,
  so a broken disk or a bad migration is recoverable.
- US-5: As a maintainer, I want server and browser errors reported to Sentry without
  secrets or personal data, so I learn about failures before users report them.
- US-6: As the operator, I want a smoke check after every deploy, so TLS, proxy or OAuth
  misconfiguration is caught right away.
- US-7: As the operator, I want logs and containers to stay within the VM's disk and memory,
  so the host never fills up or OOM-kills Postgres.
- US-8: As the first Admin (or a Member) in a fresh workspace, I want the UI to tell me that
  agents must be created before a review can run, so I'm not stuck at a button that does nothing.
- US-9: As a developer on the team, I want to connect my local Claude Code MCP to the shared
  server with a personal token, following the runbook.

## Acceptance criteria (EARS)

### Runbook (US-1, US-9)
- AC-1: The repository **shall** contain a deployment runbook `docs/deployment.md`, linked
  from a "Deploying for a team (server mode)" section in `README.md`. In this order, it covers:
  VM prerequisites, DNS, Google OAuth client, filling `deploy/.env`, static check, first
  start, first Admin, provider/LLM keys, creating agents, connecting MCP, smoke check,
  update, rollback, backup & restore, disk & logs, Sentry, and troubleshooting.   _(observable: doc review against this list; the README link resolves)_
- AC-2: The runbook's prerequisites section **shall** state the minimum and recommended VM
  size (Non-functional), the supported OS family, the required Docker Engine and Compose
  plugin versions, inbound ports 80 and 443 (TCP) plus 443/UDP open to the internet, and a
  DNS A (and optionally AAAA) record for `PUBLIC_HOSTNAME` pointing at the VM *before* the
  first start.   _(observable: doc review)_
- AC-3: The runbook **shall** give the Google Cloud steps to create an OAuth "Web
  application" client: an Internal consent screen for a Workspace domain, and the
  authorized redirect URI written exactly as `https://<PUBLIC_HOSTNAME>/api/auth/google/callback`.
  It **shall** also say which values go into `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `AUTH_ALLOWED_DOMAIN`.   _(observable: doc review; the URI string matches the one in `deploy/.env.example`)_
- AC-4: The runbook **shall** give one generation command for each secret setting. It
  **shall** require `chmod 600 deploy/.env`. It **shall** tell the operator to store
  `SECRETS_MASTER_KEY` and the three DB passwords off the VM (a password manager), and say
  that a DB dump cannot decrypt provider secrets without the master key.   _(observable: doc review)_
- AC-5: The runbook **shall** cover the first-run steps in order:
  1. Run `bash deploy/check-compose.sh deploy/.env`.
  2. Run the first `up`.
  3. Run the smoke check.
  4. The person listed in `AUTH_ADMIN_EMAILS` signs in and becomes Admin.
  5. The Admin enters GitHub/GitLab tokens and LLM keys in Settings (or runs the one-time
     `secrets:import`).
  6. The Admin **creates review agents manually** in the Agents UI. The runbook states that
     production starts with zero agents and no demo data.
  7. The Admin connects the first repository.   _(observable: doc review)_
- AC-6: The runbook **shall** describe how to connect a local MCP client to the shared
  server: create a personal API token in Settings → API tokens, then set
  `DEVDIGEST_API_BASE=https://<PUBLIC_HOSTNAME>/api` and `DEVDIGEST_API_TOKEN`. It **shall**
  say the token must not be committed, and link the token-revocation spec for a leaked token.   _(observable: doc review; following the steps on a deployed server makes the MCP agent-list tool return the workspace agents)_
- AC-7: The runbook's troubleshooting section **shall** give the symptom, cause and fix for at
  least: no certificate issued (DNS or ports), Google `redirect_uri_mismatch`, sign-in
  bouncing to the sign-in error page (proxy / `TRUST_PROXY` / plain HTTP), `migrate` exiting
  non-zero (placeholder or weak password), "another DevDigest API instance is running", the
  "No admin" boot warning, undecryptable secrets after a master-key change, disk full, and a
  container restarting after being OOM-killed.   _(observable: doc review)_
- AC-8: Every `deploy/.env` setting named in the runbook **shall** exist in
  `deploy/.env.example`. Every setting in `deploy/.env.example` **shall** have a comment that
  says whether it is secret, required or optional, and gives its default.   _(observable: an automated consistency check run by `check-compose.sh` fails when the runbook names a setting missing from `.env.example`)_

### Update & rollback (US-2, US-3)
- AC-9: **WHEN** the operator runs the update script, the system **shall** first refuse to
  continue, with exit code non-zero and **no** change to code, images, containers or DB, if
  any of these holds: `deploy/.env` is missing; tracked files have local changes; the
  checkout is not on the configured deploy branch; or another update or rollback holds the
  update lock.   _(observable: scripted test — each condition → distinct message, non-zero exit, `git rev-parse HEAD` and `docker compose ps` unchanged)_
- AC-10: **WHEN** the remote deploy branch has no commits newer than the deployed one, the
  update script **shall** report "already up to date" and exit 0 without a dump, a build or
  a restart.   _(observable: running it twice in a row → the second run takes < 30 s and creates no dump file)_
- AC-11: **WHEN** the update is about to proceed, the update script **shall** take a
  pre-update dump (same guarantees as AC-23 to AC-26, labelled with the current commit),
  and **shall** record the current commit as the previous version before changing anything.
  **IF** the dump fails, **THEN** it **shall** abort with nothing changed.   _(observable: a new pre-update dump file named with the old sha exists; the state file holds the old sha; with the backup dir made read-only the update aborts and HEAD is unchanged)_
- AC-12: The update script **shall** update the checkout **only by fast-forward** to the
  remote deploy branch. **IF** a fast-forward is not possible, **THEN** it **shall** abort
  before building, with the checkout left on the previous commit.   _(observable: diverged local branch → abort message, HEAD unchanged)_
- AC-13: **WHEN** the checkout is updated, the update script **shall** run
  `check-compose.sh deploy/.env` and then build the new images **while the running
  containers keep serving**. **IF** the check or the build fails, **THEN** it **shall**
  check out the previous commit again, leave the running containers untouched and exit
  non-zero.   _(observable: an introduced build error → the site keeps answering 200 throughout; HEAD back to the previous sha)_
- AC-14: **WHERE** the new commit adds database migrations that the deployed commit lacks,
  the update script **shall** stop the `api` service before migrations run. That way no
  old-code API serves requests against a migrated schema (G-9, D-8). **WHERE** it adds
  none, the API **shall** be recreated in the normal way.   _(observable: an update that adds a migration → no request is served by the old API after `migrate` starts (container timestamps / logs); an update without migrations → `api` is recreated once)_
- AC-15: **WHEN** the new containers are started, the update script **shall** wait up to the
  configured health timeout (default 180 s) for `api` to report healthy (its health check
  calls `/health/ready`) and `web` to report healthy. It **shall** then run the smoke check
  (AC-50) against `PUBLIC_HOSTNAME`. The update counts as successful only if all of these pass.   _(observable: successful run prints old sha → new sha and "smoke: ok", exit 0)_
- AC-16: **IF** the health wait or the smoke check fails **and** the update applied no new
  migration, **THEN** the update script **shall** roll back on its own: check out the
  previous commit, bring back the previous images (no rebuild when they still exist), start
  them, wait for health again, and exit non-zero with "rolled back to <sha>".   _(observable: an update whose API cannot boot → site is back on the old sha within the rollback budget; exit code ≠ 0)_
- AC-17: **IF** the health wait or the smoke check fails **and** the update applied at least
  one new migration, **THEN** the update script **shall not** restore the database on its
  own. It **shall** exit non-zero with a separate exit code and print the exact commands to
  restore the named pre-update dump and redeploy the previous commit. It **shall** warn
  that anything written after the dump is lost.   _(observable: forced failure after a migration → output names the dump file and the previous sha; DB untouched)_
- AC-18: The runbook and the update script's help text **shall** state that migrations are
  forward-only. Rolling back over a migration means restoring the pre-update dump, and
  every review, comment, setting, audit event and session written since the dump is lost.   _(observable: doc review; `--help` output)_
- AC-19: **WHEN** the operator runs the update script's rollback mode, the system **shall**
  redeploy the recorded previous commit. **IF** that commit is missing migrations that are
  applied to the DB, **THEN** it **shall** refuse and point to the restore procedure (AC-29).   _(observable: rollback after a migration-free update → previous sha live, exit 0; after a migrating update → refusal naming the dump)_
- AC-20: **WHEN** an update succeeds, the update script **shall** remove dangling images and
  build cache, keeping the images of the current and the previous commit.   _(observable: `docker image ls` after 3 updates shows at most 2 tagged generations per image; build cache size does not grow across no-op rebuilds)_
- AC-21: The update and rollback output **shall never** contain the value of any secret
  setting. Messages name settings only.   _(observable: a run with canary secret values in `deploy/.env` → none of the canaries appears in stdout/stderr)_

### Backups & restore (US-4)
- AC-22: The deployment **shall** include a long-lived `backup` service. It publishes no
  port, is attached only to the internal DB network, and **shall** make a full logical dump
  of the database every night at the configured time (default 03:15 UTC). The dump
  includes every schema (with the migrations journal) and every table (with `audit_events`)
  in a compressed format that a restore tool can read.   _(observable: `check-compose.sh` asserts no ports / `db`-only network; after the scheduled time a new dump exists; listing its table of contents shows every public table, `audit_events`, and the migrations journal)_
- AC-23: The `backup` service **shall** connect as a dedicated read-only role (D-5): neither
  the owner role nor the API runtime role. The role can read every table and sequence, and
  every write and DDL statement fails for it. Like the runtime role, it **shall** be created
  and re-keyed only by the one-shot `migrate` step, from its own password setting. The
  password must be ≥ 32 characters of `[A-Za-z0-9_-]` and differ from the other two passwords.   _(observable: integration test — as the backup role, SELECT on every table succeeds and INSERT/UPDATE/DELETE/TRUNCATE/CREATE each fail; a placeholder/short/duplicate password makes `migrate` and `check-compose.sh` fail naming the setting only)_
- AC-24: The backup password **shall never** appear in a process argument list, a log line,
  a dump file name or a dump's contents.   _(observable: during a dump, the process list inside the container shows no password; a canary password does not appear in `docker logs` or the dump file)_
- AC-25: **WHEN** a dump is written, the system **shall** write it to a temporary name,
  verify that it can be read back (table-of-contents listing succeeds), and only then
  rename it to its final name. **IF** any step fails, **THEN** it **shall** delete the
  partial file, keep every earlier dump, and log the failure. The service **shall** keep
  running.   _(observable: disk filled during a test dump → no partial file; previous dumps intact; error line in the backup service log)_
- AC-26: **WHEN** a nightly dump succeeds, the system **shall** delete older nightly dumps
  beyond the newest `BACKUP_RETAIN` (default 14, minimum 1). Pre-update dumps **shall** be
  rotated separately, keeping the newest `BACKUP_RETAIN_PRE_UPDATE` (default 5, minimum 1).
  Rotation **shall** never run after a failed dump.   _(observable: with retain=3 and 5 dumps present → 3 newest remain; a failed dump deletes nothing; nightly rotation never deletes a pre-update dump)_
- AC-27: Dumps **shall** be stored in a host directory set by `BACKUP_DIR` (default a
  git-ignored directory under `deploy/`). The directory **shall** have mode 0700 and each
  dump file 0600.   _(observable: `stat` on the dir and files; `git status` stays clean after a dump)_
- AC-28: **IF** no dump has succeeded within the last 26 hours (after a start-up grace period
  of 26 hours from the service's first start), **THEN** the `backup` service **shall**
  report unhealthy.   _(observable: `docker compose ps` shows `unhealthy` when the newest dump is backdated 27 h)_
- AC-29: The runbook **shall** describe the restore procedure:
  1. Stop `api`, `web` and `backup`.
  2. As the owner role, drop and re-create the database.
  3. Restore the chosen dump without the original ownership or privileges.
  4. Run `up -d`, so that `migrate` re-applies grants (and any newer migrations) before the API starts.
  5. Run the smoke check.

  It **shall** say that the same `SECRETS_MASTER_KEY` must be in place, or stored provider
  secrets stay undecryptable.   _(observable: doc review; a drill that follows the doc ends with a healthy smoke check)_
- AC-30: The restore procedure **shall** be covered by an automated integration test. The test
  seeds rows in every table (including `audit_events` and the migrations journal), dumps
  with the backup role, restores into an empty database the documented way, and asserts:
  per-table row counts are equal, a following `migrate` applies nothing, and the runtime
  role's privileges match `grants.sql`.   _(observable: the test passes in the server integration suite)_
- AC-31: The runbook **shall** state in a warning block that backups are local only, that
  losing the VM or its disk loses every backup, and that the operator should copy dumps
  off the VM by hand on a schedule they choose.   _(observable: doc review)_

### Error monitoring — Sentry (US-5)
- AC-32: **WHERE** the API's Sentry DSN setting is non-empty and `NODE_ENV` is not `test`,
  the API **shall** report errors to Sentry. **WHERE** it is empty or unset, the API
  **shall not** initialise any reporter, **shall not** open any connection to Sentry, and
  **shall** behave exactly as today. This covers local mode too.   _(observable: hermetic test with DSN unset → no reporter initialised, no outbound request; the full existing server suite passes with no new config)_
- AC-33: **WHERE** the web build-time Sentry DSN is non-empty, the browser app **shall**
  report errors to Sentry. **WHERE** it is empty, the browser bundle **shall** make no
  request to any Sentry host.   _(observable: web build without DSN → network log of a full page session has no Sentry request; client test suite unchanged)_
- AC-34: The API **shall** report:
  - every error that becomes a 5xx response;
  - uncaught exceptions and unhandled promise rejections;
  - background job failures (clone, index, review run, publish) caused by an internal error.

  It **shall not** report 4xx responses, validation errors or expected application errors
  with a status below 500.   _(observable: hermetic test — a route throwing a plain Error → one captured event; a 404/422/401 → none)_
- AC-35: The web app **shall** report render errors caught by its error boundaries (the
  route-level and global error pages) and unhandled promise rejections in the browser. It
  **shall not** report API error responses (the API reports its own 5xx).   _(observable: client test — throwing in a component → one capture; an `ApiError` 500 from a hook → no capture)_
- AC-36: Every event sent by the API or web **shall** be scrubbed before sending so that none
  of the following appears anywhere in the serialized event (request data, headers, URL,
  query string, breadcrumbs, exception message, extra/context, tags):
  - `Authorization`, `Cookie` and `Set-Cookie` header values;
  - session ids;
  - personal API tokens;
  - GitHub/GitLab/LLM provider tokens;
  - the secrets master key;
  - Google client secret, ID tokens, OAuth `code` and `state`;
  - DB passwords.

  Request bodies **shall never** be attached. Local-variable capture **shall** be off.   _(observable: hermetic test builds an event containing each canary in each location → the serialized output contains none of them; same test for the web scrubber)_
- AC-37: The exception message of an API event **shall** go through the same credential
  redaction the server applies to logs and 5xx responses before it is sent.   _(observable: an adapter error whose message embeds `https://x:TOKEN@host` → the event message shows the redacted form)_
- AC-38: Events **shall** identify the user by internal user id only. They **shall** carry no
  email, display name, avatar or IP address (D-6).   _(observable: captured event for a signed-in user has `user.id` only; IP not present)_
- AC-39: Every event **shall** carry a release tag equal to the deployed git commit sha, the
  same for API and web, and a configurable environment tag (default `production`).
  **IF** the sha is not available, **THEN** the release tag **shall** be `unknown`, and
  boot and build **shall** still succeed.   _(observable: deploy via the update script → events tagged with `git rev-parse HEAD`; a plain `docker compose build` → `unknown`, no failure)_
- AC-40: The integration **shall** send error events only. Performance tracing, profiling and
  Session Replay **shall** be disabled, so no PR code, diff or DOM content is captured (D-7).   _(observable: config test asserts trace/profile/replay sample rates are 0 and no replay integration is loaded)_
- AC-41: reviewer-core **shall** contain no Sentry dependency or import. Errors from inside
  the engine are reported by the server where they surface. The architecture gate **shall**
  reject any Sentry import in reviewer-core.   _(observable: `pnpm arch` fails on a test import of a Sentry package from reviewer-core; reviewer-core `package.json` unchanged)_
- AC-42: **IF** Sentry is unreachable, rate-limits the client or the DSN is malformed, **THEN**
  request handling, background jobs, boot and shutdown **shall** be unaffected. A malformed
  DSN **shall** produce one boot warning that names the setting, never its value.   _(observable: DSN pointing at a black-hole host → p95 of `/health/ready` unchanged within 5 ms; malformed DSN → API boots with one warning line)_
- AC-43: **WHEN** the API shuts down, it **shall** flush pending events for at most 2 s,
  inside the existing graceful-shutdown window.   _(observable: SIGTERM with a queued event → process exits within existing shutdown budget + 2 s)_
- AC-44: The web DSN **shall** be a build-time, public value, documented in `.env.example` and
  the runbook as non-secret, so changing it needs a rebuild. **IF** the proxy's CSP ever
  restricts `connect-src` or `default-src`, **THEN** `check-compose.sh` **shall** fail
  unless the CSP allows the web DSN's ingest origin.   _(observable: `check-compose.sh` with a test Caddyfile adding `connect-src 'self'` and a web DSN set → FAIL naming the CSP; current Caddyfile → ok)_

### Compose hygiene (US-7)
- AC-45: Every service in the deployment **shall** use bounded log rotation, by default at
  most 5 files of 10 MB each per container, configurable from `deploy/.env`.   _(observable: `check-compose.sh` asserts a max-size and max-file on every service; `docker inspect` shows the log config)_
- AC-46: Every service **shall** declare a memory limit and a CPU limit. The defaults are in
  the Non-functional table, and each is overridable from `deploy/.env`.   _(observable: `check-compose.sh` asserts a memory and CPU limit on every service)_
- AC-47: **IF** a long-lived service is killed for exceeding its memory limit, **THEN** it
  **shall** be restarted by its restart policy. API runs left running **shall** be reaped
  on boot (existing behaviour).   _(observable: forced OOM of `api` in a test env → container restarts; orphaned run shows as failed, not running)_
- AC-48: The runbook's "disk & logs" section **shall** list every source of disk growth:
  - `pgdata`;
  - the `clones` volume: one clone per repo ever connected, **never deleted when a repo is
    removed** (G-6);
  - `BACKUP_DIR`;
  - Docker images and build cache;
  - container logs, bounded by AC-45.

  It **shall** give a command to see usage per source, a manual procedure to delete the
  clone of a removed repository, and a recommendation to act at 80 % disk usage.   _(observable: doc review)_
- AC-49: `check-compose.sh` **shall** also assert:
  - the `backup` service publishes no port and is only on the internal DB network;
  - its DB user is the backup role, not the owner or the runtime role;
  - its environment holds no setting matching the secret-like pattern other than its own
    DB password;
  - it uses the same Postgres major version image as `postgres`;
  - it has `restart: unless-stopped`, `no-new-privileges` and a health check.   _(observable: each mutation of the compose file in a scratch copy → the matching check FAILs)_

### Post-deploy smoke check (US-6)
- AC-50: **WHEN** the operator runs the smoke script with a bare host name, the system
  **shall** run the checks AC-51 to AC-56 using no credentials, sending no cookies and
  storing none. It **shall** print one ok/FAIL line per check and exit 0 only if every
  check passes.   _(observable: run against a healthy deploy → all ok, exit 0; against a stopped API → FAIL lines, exit ≠ 0)_
- AC-51: The smoke script **shall** verify that `http://<host>/` answers with a permanent
  redirect to `https://<host>/`.   _(observable: FAIL when port 80 is closed)_
- AC-52: The smoke script **shall** verify that `https://<host>/` presents a certificate
  valid for the host, with no insecure-TLS bypass, and that the response carries
  `Strict-Transport-Security` with `max-age` ≥ 31536000.   _(observable: FAIL against a self-signed / staging cert)_
- AC-53: The smoke script **shall** verify that `GET https://<host>/api/health/ready` answers
  200 with `ready: true`.   _(observable: FAIL with Postgres stopped)_
- AC-54: The smoke script **shall** verify that an unauthenticated `GET` to a protected API
  route answers 401.   _(observable: FAIL if the guard were off)_
- AC-55: The smoke script **shall** verify that `GET https://<host>/api/auth/google/start`
  answers with a redirect whose location host is `accounts.google.com`. **IF** it redirects
  to the app's sign-in error page instead, **THEN** the check **shall** FAIL with a hint
  pointing at `TRUST_PROXY` / the proxy chain.   _(observable: with `TRUST_PROXY` changed to a wrong IP → FAIL with the hint)_
- AC-56: The smoke script **shall** verify that `GET https://<host>/` answers 200 with an
  HTML document from the web app.   _(observable: FAIL with `web` stopped)_
- AC-57: **IF** the host argument has a scheme, port, path or credentials, or does not
  resolve, **THEN** the smoke script **shall** exit non-zero within 15 s with a message
  naming the problem.   _(observable: `smoke https://x` → usage error; unresolvable host → DNS error)_

### Zero-agents empty state (US-8)
- AC-58: **WHILE** the workspace has no enabled agent, the "Run all enabled agents" item in
  the Run-review dropdown **shall** be non-actionable (focusable, `aria-disabled`, sends no
  request) and **shall** show a localized hint that no agent is enabled.   _(observable: client test — zero enabled agents → clicking the item fires no mutation; hint text present)_
- AC-59: **WHILE** the workspace has zero agents, the dropdown's agent section **shall** show a
  localized, role-aware entry. For an Admin it reads "No agents yet — create one" and
  navigates to the Agents page with the create flow open. For a Member it reads "No agents
  yet — ask an Admin to create one" and is non-actionable.   _(observable: client tests per role; no hard-coded English string in the component)_
- AC-60: **WHILE** the Agents list is empty and the viewer is a Member, the empty state
  **shall** say that only an Admin can create agents, instead of telling the Member to
  create one. The Admin empty state and its CTA stay as they are.   _(observable: client test per role)_
- AC-61: **IF** the server receives a run-all-enabled-agents request and the workspace has no
  enabled agent, **THEN** it **shall** answer 409 with the error code `no_enabled_agents`
  and a message telling the user to create or enable an agent. It **shall** create no run
  (D-10).   _(observable: integration test — zero enabled agents → 409 `no_enabled_agents`, no `agent_runs` row; one enabled agent → unchanged 2xx)_

### Traceability
| Story | ACs |
|---|---|
| US-1 | AC-1, AC-2, AC-3, AC-4, AC-5, AC-7, AC-8 |
| US-2 | AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-15, AC-20, AC-21 |
| US-3 | AC-16, AC-17, AC-18, AC-19 |
| US-4 | AC-22 to AC-31, AC-49 |
| US-5 | AC-32 to AC-44 |
| US-6 | AC-50 to AC-57, AC-15 |
| US-7 | AC-45, AC-46, AC-47, AC-48 |
| US-8 | AC-5, AC-58, AC-59, AC-60, AC-61 |
| US-9 | AC-6 |

## Edge cases
- DNS not yet pointing at the VM on first `up`: Caddy cannot get a certificate. The smoke
  check fails on TLS, and the runbook troubleshooting covers it → AC-2, AC-7, AC-52.
- Let's Encrypt rate limit after repeated failed attempts → accepted: the runbook explains it (AC-7); no handling in code.
- Update started while review runs are in flight: the API restart ends them, and they are
  reaped as failed on boot (existing behaviour). Users re-run them → accepted: the runbook
  says to update outside working hours. No drain logic.
- Update started while the nightly backup is running → the update lock and dump naming keep
  them apart, and the pre-update dump is its own file → AC-11, AC-25.
- Two update invocations at once → AC-9 (lock).
- Network down during `git fetch` → abort before any change → AC-12 (no fast-forward possible) / AC-9.
- The VM runs out of disk during the image build → AC-13 (old containers keep serving).
- The VM runs out of disk during a dump → AC-25.
- The new commit changes `deploy/.env.example` (new required setting) and the operator's
  `deploy/.env` lacks it → `check-compose.sh` fails after the pull and the update rolls
  the checkout back → AC-13. The runbook tells the operator to diff `.env.example` on update → AC-1.
- A migration succeeds but the new API fails to boot → AC-17 (guided restore, no auto DB restore).
- `migrate` itself fails halfway. A migration runs in its own transaction, so earlier
  migrations stay applied → treated as "applied migrations"; AC-17 applies.
- Previous images were pruned before a rollback → the rollback rebuilds from the previous
  commit (slower, still correct) → AC-16.
- Restoring a dump taken before a later migration → `migrate` applies the newer migrations after the restore → AC-29.
- Restoring with a different `SECRETS_MASTER_KEY` → secrets stay undecryptable. The existing
  boot report names them, and the runbook warns about it → AC-29, AC-7.
- A dump taken while the API is writing → a logical dump reads one consistent snapshot and takes no blocking locks → accepted: no handling needed.
- The `backup` service starts before `migrate` has created the backup role → its connection
  fails, it logs the failure and retries on the next schedule. It reports unhealthy only
  after the 26 h grace → AC-25, AC-28.
- Clock or timezone on the VM differs from the configured schedule → the schedule is in UTC → AC-22.
- Sentry event contains PR-derived text in an error message (e.g. a file path from a diff) →
  this is untrusted data and is sent only after scrubbing. Sentry does not execute it → AC-36, *Untrusted inputs*.
- Sentry quota exhausted → AC-42.
- A Sentry DSN is set in a test environment → ignored because `NODE_ENV=test` → AC-32.
- A burst of identical 5xx errors (a provider outage) → accepted: Sentry's own grouping and quotas handle it; no client-side sampling.
- An agent exists but is disabled; "Run all" with zero *enabled* → AC-58, AC-61. Running that
  specific agent stays possible (existing behaviour).
- A Member opens a PR in a zero-agents workspace → AC-59.
- The MCP run-review tool with "all" and zero enabled agents now gets 409 instead of an empty
  list. The MCP's existing generic error mapping shows the message → AC-61.
- A repository removed in the UI leaves its clone on disk → AC-48 (manual cleanup), Open question.
- The smoke check is run from the VM itself (hairpin NAT may fail) → accepted: the runbook
  says to run it from a workstation. The update script runs it from the VM and the runbook
  documents the hairpin caveat.
- The Google consent screen is set to "External" by mistake → the domain restriction still
  applies (base spec). The runbook recommends Internal → AC-3.

## Non-functional
- **VM size:** minimum 2 vCPU / 4 GiB RAM + 2 GiB swap / 40 GB SSD. Recommended 4 vCPU /
  8 GiB / 80 GB. The image build on the VM needs about 2 GiB free memory.
- **Resource-limit defaults (AC-46):**

  | Service | Memory | CPU |
  |---|---|---|
  | proxy | 256 MiB | 0.5 |
  | web | 512 MiB | 1.0 |
  | api | 2 GiB | 1.5 |
  | migrate | 1 GiB | 1.0 |
  | postgres | 1 GiB | 1.0 |
  | backup | 512 MiB | 0.5 |

- **Logs:** ≤ 50 MB per container by default (AC-45), so at most 300 MB for all six services.
- **Update downtime:** the time during which the site returns non-2xx on `/` or
  `/api/health/ready` **shall** be ≤ 120 s for an update without migrations, on a VM of the
  minimum size. The build is excluded because it happens while the old version serves (AC-13).
- **Rollback without migrations (AC-16):** back on the previous version ≤ 5 min when the
  previous images exist.
- **Smoke check:** each request times out after 10 s, and the whole run takes ≤ 60 s.
- **Backup:** a dump of a 2 GB database finishes in ≤ 15 min on the minimum VM. The API's
  p95 `/health/ready` latency stays < 200 ms during a dump.
- **Sentry overhead:** p95 API latency changes by < 5 ms with Sentry enabled. Event delivery
  is asynchronous.
- **Security:**
  - No secret value in any script output, process argument list, log line, Sentry event or
    image layer (AC-21, AC-24, AC-36). The test method is canary values plus a grep.
  - Dumps are 0600 in a 0700 directory (AC-27).
  - The backup role is read-only (AC-23).
  - The web Sentry DSN is the only new value inlined into the browser bundle, and it is public.

## Cross-module interactions
- **deploy ↔ server:**
  - The update script and the smoke check call the API's health and auth-start routes. The
    contracts are the existing ones: `/health/ready` gives 200/503, `/auth/google/start`
    gives a 302.
  - The `migrate` step now also creates and re-keys the backup role (deploy grants step).
    The server's own migrations are unchanged.
  - Failure contract: health 503 or a timeout → update failure path (AC-16/17).
- **deploy ↔ client:** the web build receives the public web DSN and the release sha at build
  time. A missing value means monitoring is off, never a build failure.
- **server ↔ Sentry (external), client ↔ Sentry (external):**
  - Outbound only. Events are scrubbed before they leave the process.
  - Failure contract: fire-and-forget. Any Sentry failure is swallowed (AC-42).
  - The API reaches Sentry over the existing `edge` network egress, and the browser reaches
    it directly. The `backup` service has **no** egress and does not report to Sentry; its
    health check is its signal (AC-28).
- **client ↔ server (zero agents):** run-all with no enabled agent → 409
  `no_enabled_agents` (AC-61). The client also blocks the action up front (AC-58), so the
  409 is a fallback for stale lists and MCP callers.
- **mcp ↔ server:** unchanged, apart from the 409 above being shown through the existing
  error mapping. The runbook documents its configuration (AC-6).
- **reviewer-core:** no interaction with Sentry. Engine errors surface through the server's
  capture (AC-41).

```mermaid
flowchart TD
  start([update.sh]) --> pre{preflight ok?<br/>env, clean tree, lock}
  pre -- no --> abort0([exit ≠0, nothing changed])
  pre -- yes --> ff{new commits?}
  ff -- no --> uptodate([already up to date, exit 0])
  ff -- yes --> dump[pre-update dump + record previous sha]
  dump -- fail --> abort0
  dump --> pull[fast-forward checkout]
  pull --> check[check-compose + build<br/>old containers keep serving]
  check -- fail --> revert([checkout previous sha, exit ≠0])
  check --> mig{new migrations?}
  mig -- yes --> stopapi[stop api] --> up[up -d: migrate → api → web → proxy]
  mig -- no --> up
  up --> health{healthy + smoke ok?}
  health -- yes --> prune[prune old images] --> done([exit 0])
  health -- "no, no migrations" --> rb[auto rollback to previous sha] --> fail1([exit ≠0 'rolled back'])
  health -- "no, migrated" --> guide([print restore + rollback commands, exit ≠0])
```

```mermaid
sequenceDiagram
  participant B as backup service (db network only)
  participant P as postgres
  participant D as BACKUP_DIR (host)
  Note over B: nightly at BACKUP schedule (UTC)
  B->>P: logical dump as read-only backup role (password via env/passfile)
  P-->>B: consistent snapshot stream
  B->>D: write temp file (0600)
  B->>B: verify table of contents
  alt verified
    B->>D: atomic rename, then rotate (keep newest N)
  else failed
    B->>D: delete temp, keep all previous
    Note over B: health check → unhealthy after 26 h without success
  end
```

## Contracts
Shapes only; names are the operator-facing interface.

**New `deploy/.env` settings** (all documented in `.env.example`, AC-8):

| Setting | Secret | Required | Default | Consumer |
|---|---|---|---|---|
| `BACKUP_DB_PASSWORD` | yes | yes | — (≥ 32 chars `[A-Za-z0-9_-]`, ≠ other DB passwords) | `migrate` (creates role), `backup` |
| `BACKUP_SCHEDULE` | no | no | `03:15` UTC daily | `backup` |
| `BACKUP_RETAIN` | no | no | `14` (min 1) | `backup` |
| `BACKUP_RETAIN_PRE_UPDATE` | no | no | `5` (min 1) | `backup`, update script |
| `BACKUP_DIR` | no | no | git-ignored dir under `deploy/` | `backup`, update script, runbook |
| `SENTRY_DSN` | treat as sensitive (not in UI/logs) | no | empty = off | `api` (runtime) |
| `SENTRY_WEB_DSN` | no (public) | no | empty = off | `web` (build time) |
| `SENTRY_ENVIRONMENT` | no | no | `production` | `api`, `web` |
| `LOG_MAX_SIZE` / `LOG_MAX_FILE` | no | no | `10m` / `5` | all services |
| per-service memory / CPU overrides | no | no | Non-functional table | all services |

Release sha: provided by the update script at build time (web) and runtime (api). Its
absence yields `unknown` (AC-39). It is not an operator setting.

**Update script CLI:** `update` (default) and `rollback` modes, plus `--help`. Exit codes:
`0` success or already up to date; `1` preflight / check / build failure, nothing deployed;
`2` deployed but unhealthy, auto-rolled back; `3` deployed, unhealthy, migrations applied,
manual restore required. The state file records `previous_sha`, `current_sha`, `pre_update_dump`
and `migrations_applied` (boolean).

**Smoke script CLI:** one positional bare host name. Output is one line per check
`ok|FAIL <check-name> [hint]`. Exit `0` = all checks pass, non-zero otherwise.

**Dump files:** `devdigest-<UTC yyyymmddThhmmssZ>-<nightly|pre-update-<short sha>>.<ext>`,
one file per dump, no password or host in the name.

**API error (new code, existing envelope):** `POST /pulls/:id/review` with `all: true` and no
enabled agent → `409 { error: { code: "no_enabled_agents", message } }`. No change to the
shared contracts: the error envelope already exists, and the code is added as a value.

**Sentry event (outbound):** `user` = `{ id }` only; tags `release`, `environment`, route
template, HTTP method/status. For job failures, a `run_id` / job kind tag. No request body,
no cookies, no headers outside an allowlist (`user-agent`, `content-type`), no IP.

## Untrusted inputs
- **Sentry events** may contain text that comes from PR content or LLM output, for example
  a file path or a provider error message that echoes input. It is treated as data. It is
  scrubbed (AC-36/37), sent only to Sentry, and never fed to a model or executed. Sentry's
  UI renders it as text.
- **Smoke script** reads HTTP status codes and headers from the network. It only compares
  them to fixed expectations and never evaluates response content.
- **Update script** deploys whatever is on the configured remote branch. The branch is
  trusted by policy (only the team's own repo, fast-forward only, AC-12). The runbook says
  that write access to that branch equals deploy access to the VM.
- No change to how diffs or PR bodies reach the review engine: the existing
  `wrapUntrusted()` and grounding gate are untouched.

## Decisions
Each decision is marked either **user-confirmed (2026-11-06)** or **spec author, recommended default**.
- **D-1 (user-confirmed): Delivery is `git pull` plus a build on the VM.** No registry and no CI deploy.
- **D-2 (user-confirmed): Backups are local nightly logical dumps.** Off-site copies are a non-goal, and the risk is stated (AC-31).
- **D-3 (user-confirmed): Sentry for API and web, opt-in by DSN.**
- **D-4 (user-confirmed): Built-in agents are created manually in the UI.** `db:bootstrap`
  is unchanged. The fix is documentation (AC-5) plus a clear empty state (AC-58 to AC-61).
- **D-5 (spec author): A dedicated read-only backup role.** Using the owner role would keep
  a superuser password in a long-lived container. The runtime role cannot read the
  migrations schema, so its dump could not restore migration state. A role with read-only
  access to all data needs neither.
- **D-6 (spec author): Sentry user = internal id only, no email.** This keeps personal data
  low with a third party. An Admin can map the id to a member in the Members list.
- **D-7 (spec author): Errors only — no tracing or Replay.** Replay would record the DOM,
  which includes PR code and findings. Tracing is out of scope for "know when it breaks".
- **D-8 (spec author): Stop the API before migrating, but only when the update adds
  migrations.** This closes the window where old code serves on a new schema (G-9). It
  costs a few seconds of extra downtime, and only on those updates.
- **D-9 (spec author): Automatic rollback only when no migration was applied.** Restoring a
  dump throws away data. That decision belongs to a person, so the script prints the exact
  commands instead (AC-17).
- **D-10 (spec author): Run-all with no enabled agent returns 409.** A silent 200 with no
  runs hides the problem from the UI and from MCP callers.
- **D-11 (spec author): Clone growth is documented, not fixed here.** Deleting the clone on
  repo removal is a server behaviour change with its own edge cases, such as a running index
  job (Open question).
- **D-12 (spec author): Sentry is active only when a DSN is set and `NODE_ENV` ≠ `test`.**
  Tests stay hermetic even if a developer's shell exports a DSN.

## Open questions
- [NEEDS CLARIFICATION: Should removing a repository also delete its clone (and should the
  GitHub PR-head fetch get a depth limit like GitLab's)? Recommended: yes, as a small
  follow-up server spec (G-6).]
- [NEEDS CLARIFICATION: Sentry hosting — sentry.io (US or EU data region) or self-hosted?
  This is company policy on sending error data to a third party. The spec works with any DSN.]
- [NEEDS CLARIFICATION: Upload web source maps to Sentry? That needs a Sentry auth token at
  build time on the VM (a new build-time secret). Default: no. Stack traces stay minified.]
- [NEEDS CLARIFICATION: Should a failed nightly backup be visible beyond the container
  health status? For example, a "last backup" line on an Admin settings page. Default: no,
  the health check plus a runbook check only.]
- [NEEDS CLARIFICATION: Should review-run failures caused by provider errors (LLM 5xx,
  rate limit) be reported to Sentry, or only internal errors? Default: internal only (AC-34),
  to avoid noise during provider outages.]
- [NEEDS CLARIFICATION: Confirm the VM size and resource-limit defaults against the team's
  real repos (index of the largest repo, peak API memory during a multi-agent run).]
- [NEEDS CLARIFICATION: Deploy branch name, and how the VM gets read access to the repo
  (deploy key vs public fork). The runbook needs one documented path.]
