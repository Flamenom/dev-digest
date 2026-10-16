# Implementation Plan: GitLab repository & merge-request support (read-only MVP) + sync-on-open

> Source spec: `specs/2026-10-16-gitlab-merge-requests.md` (Spec ID `SPEC-2026-10-16-gitlab-merge-requests`,
> Status **approved**, 64 EARS ACs, 9 user stories). This plan does not restate, extend or amend the
> spec. It maps every AC onto files and tasks. Branch at planning time: `feat/gitlab-integration`.

## Overview

DevDigest only reviews github.com today. Every PR call goes through one global `GitHubClient`, repo
identity accepts exactly `github.com/<owner>/<name>`, and the UI hard-codes github.com links. This
plan adds **gitlab.com** as a second, per-repository provider: nested-group project URLs, a
workspace GitLab token with a connection test, MR import (metadata + batched stats on the list,
diff/commits only on the PR page), provider-correct links, and honest read-only commenting. It also
replaces the blocking "sync on every GET" PR list with a **sync-on-open** model for *all*
providers: stale-while-revalidate, single-flight per repo, 60 s TTL, 60 s failure back-off, manual
refresh that bypasses the TTL, and an SSE completion signal instead of periodic polling.
reviewer-core is untouched.

## Execution mode

**multi-agent (parallel)**. The user chose this up front. 23 tasks across server, client, mcp and
e2e. Contracts come first (T1). Each phase lists the tasks that may run concurrently, and those
tasks have **strictly non-overlapping Owned paths**. Hot files (`platform/container.ts`,
`modules/pulls/routes.ts`, `platform/config.ts`, `modules/repos/service.ts`) are edited by several
tasks, always in a **serial `Depends-on` chain**, never concurrently. All implementers share one
branch, with no worktrees.

```mermaid
flowchart LR
  subgraph P1[Phase 1 - contracts and independent]
    T1[T1 shared contracts + primitives]
    T2[T2 schema + migration]
    T14[T14 smart-diff .gitlab]
    T15[T15 MCP wording]
  end
  subgraph P2[Phase 2 - adapters and cores]
    T3[T3 GitLab adapter + mocks]
    T6[T6 git adapter host-aware]
    T7[T7 HostRepoRef threading]
    T8[T8 sync coordinator + service + repo]
    T16[T16 GitLab seed fixture]
    T17[T17 client data layer]
  end
  subgraph P3[Phase 3 - wiring]
    T4[T4 container hosts + GitHub host]
  end
  subgraph P4[Phase 4 - server slices]
    T5[T5 repo identity]
    T13[T13 settings GitLab]
    T11[T11 review diff]
  end
  subgraph P5[Phase 5 - routes]
    T9[T9 list sync routes]
    T12[T12 detail + comments]
    T10[T10 intent/brief issue]
  end
  subgraph PC[Client UI]
    T18[T18 PR list UI]
    T19[T19 PR detail UI]
    T20[T20 add repo + settings + conventions]
  end
  T1 --> T3 & T6 & T7 & T8 & T17
  T2 --> T7 & T8 & T16
  T3 --> T4
  T6 --> T4
  T1 --> T4
  T4 --> T5 & T13
  T2 --> T5
  T3 --> T11
  T6 --> T11
  T2 --> T11
  T5 --> T9
  T8 --> T9
  T4 --> T9
  T9 --> T12 --> T10
  T17 --> T18 & T19 & T20
  T12 & T10 & T11 & T16 & T14 --> T23[T23 feature-parity it-test]
  T9 & T12 & T16 & T18 & T19 & T20 --> T21[T21 e2e]
  T21 & T23 & T13 & T15 & T7 --> T22[T22 verification gate]
```

## Requirements (verified)

These are restated from the spec. The spec's AC-N ids are normative. R-ids group them, and the full
AC→task table is at the end.

- **R1: GitLab token & connection test** (AC-1–AC-5, AC-53). One `GITLAB_TOKEN` per workspace,
  status reported separately from GitHub. The test returns the username, names invalid / expired /
  revoked, lists missing scopes `read_api` + `read_repository` (or the superset `api`), and warns when
  scopes can't be introspected. The token is never echoed. Settings shows the scope hint.
- **R2: Repo identity & add** (AC-6–AC-11, AC-15, AC-16, AC-52). Hosts are exactly `github.com` /
  `gitlab.com`. GitLab paths have 2–21 segments (owner = namespace, name = last segment). Five URL
  forms (plus query/fragment stripping) normalise to one canonical path. Strict per-segment
  validation happens before any network/FS work. The GitHub rules are unchanged. Identity is
  (workspace, provider, host, full_name), GitLab duplicates are compared case-insensitively, and the
  canonical name is gitlab.com's `path_with_namespace`.
- **R3: Clone / refresh / index** (AC-12–AC-14, AC-17, AC-47). HTTPS clone, using the GitLab token
  when configured (never the GitHub token). Distinct messages for "token missing" vs "no access".
  The remote is rebuilt from the stored provider/host/path. Clone paths are namespaced per host, and
  existing GitHub clones stay in place.
- **R4: MR list import** (AC-18–AC-20, AC-22, AC-28, AC-50, AC-54). Open MRs only, metadata +
  stats from one batched GraphQL page (≤ ceil(n/100) requests, 0 diff requests). State mapping
  `opened|locked→open`, `merged`, `closed`. Draft flag. Stats unknown shows "—". MRs that leave the
  open set get their state updated. No caps.
- **R5: PR page detail** (AC-21, AC-24, AC-33, AC-51). Description, commits, per-file changes
  (previous path, new/deleted/renamed, patch) are downloaded only here, fully paginated. Too-large or
  collapsed files are persisted without a patch and flagged. Draft shows in the header. Re-download
  happens only when the head SHA changed (NFR).
- **R6: Resilience & provider isolation** (AC-25–AC-27). 3 retries with 1/2/4 s ±20 % backoff and
  `Retry-After` ≤ 30 s, 15 s per-call timeout. On failure the persisted rows stay and sync status =
  failed, with a "showing data from <time>" notice. Offline still serves persisted data. One
  provider failing never blocks the other.
- **R7: Sync-on-open, all providers** (AC-55–AC-64, AC-48). Persisted list renders immediately. A
  sync starts only outside the 60 s TTL and outside the 60 s failure back-off. Single-flight per
  repo: joiners receive the outcome. Manual refresh ignores the TTL but joins a running sync. The
  page shows an "Updating…" indicator and the last-sync time, and updates in place. No periodic
  client refetch. A sync survives navigation away. GitHub data is field-identical, just fresher.
- **R8: Review & dependent features** (AC-23, AC-29–AC-32, AC-34, AC-35). The local diff uses the
  MR head ref (fork-safe). The fallback rebuilt from patches excludes omitted files, with the count
  in the trace + UI. An empty fallback ends the run with "no reviewable diff" and no LLM call. The
  same-project linked issue feeds Intent/Brief. Intent, Brief, Smart Diff, Blast and Eval cases work
  on GitLab MRs. Smart Diff treats `.gitlab-ci.yml` / `.gitlab/` as wiring.
- **R9: Links & terminology** (AC-36–AC-42, AC-49). The repo DTO carries provider/host/web_url.
  GitLab link shapes are `/-/merge_requests/<iid>`, `/-/blob/<sha>/<path>#L<a>-<b>`. GitHub links
  are unchanged. "Pull request" + `#<n>` appear everywhere, and only "View on GitLab/GitHub" names
  the host. All new strings go through i18n. Add-repo copy shows both hosts. MCP wording is
  provider-neutral. Routes stay number-keyed.
- **R10: Read-only commenting** (AC-43–AC-45). The UI shows a disabled post control with a WCAG-AA
  associated explanation, and copy-to-clipboard instead. The server returns `provider_read_only`
  4xx with no outbound call for POST, and `200 []` for GET.
- **R11: Migration / no regression** (AC-46–AC-48). Backfill `github` / `github.com`. ids, PRs,
  reviews and clone paths are unchanged. Existing suites stay green. `pnpm arch` error rules stay at
  0. Shared copies stay byte-identical.
- **NFRs** (security allowlist / path safety / secret redaction, list-read p95 ≤ 300 ms @ 1 000 PRs,
  per-page processing p95 ≤ 200 ms, TTL deploy config default 60 s, ≤ 1 concurrent request per repo
  sync) are attached to the tasks named in "Testing strategy".

## Open questions & recommendations

Nothing was asked interactively during planning. Each gap got a default, and the user then
reviewed them (2026-10-16). Q2 and Q4 were confirmed, Q8 was **changed** (see below), and Q1, Q3,
Q5, Q6, Q7 and Q9 were accepted as defaults. **All questions are resolved.**

- **Q1 (resolved: default accepted): "One GitLab token per workspace" vs a global secrets store.** `SecretsProvider.get(key)` has
  no workspace parameter (`server/src/vendor/shared/adapters.ts:247`), and `GITHUB_TOKEN` is
  already global. → **default:** store `GITLAB_TOKEN` exactly like `GITHUB_TOKEN`, as one key in the
  single-workspace local store. That *is* one-per-workspace in today's single-workspace MVP. True
  per-workspace scoping belongs to the future multi-user spec.
- **Q2 (resolved: confirmed by the user): Shape of "PR list read + sync object".** `GET /repos/:id/pulls` returns a bare `PrMeta[]`,
  and MCP depends on that (`mcp/src/resolve.ts:49`). → **default:** keep that endpoint's shape
  unchanged (it still triggers sync-on-open), and add `GET /repos/:id/pulls/page → { pulls, sync }`
  for the UI. Manual refresh = `POST /repos/:id/pulls/sync → { trigger }`. Completion signal =
  one-shot SSE `GET /repos/:id/pulls/sync/events` (a single `done` event, then close). This is not
  polling, so AC-63 holds.
- **Q3 (resolved: default accepted): Status code for `provider_read_only`.** → **default:** `400`, with code `provider_read_only`.
  That mirrors the existing `github_unavailable` / `github_comment_failed` 400s and stays distinct
  from `gitlab_token_missing`.
- **Q4 (resolved: confirmed by the user): What the PR-list "Refresh" button does.** Today `FilterBar` calls `POST /repos/:id/refresh`
  (re-clone + reindex). → **default:** the button starts/joins the PR-list sync (AC-58) **and** keeps
  calling `/repos/:id/refresh`, so the existing clone refresh isn't lost from the UI. One button
  does both. (A later UX pass could still split it; that is out of scope.)
- **Q5 (resolved: default accepted): AC-32 "no reviewable diff" for GitHub.** → **default:** apply it provider-agnostically. An
  empty diff can only produce findings that grounding drops, so skipping the LLM call there is pure
  saving. If an existing GitHub test relies on an LLM call with an empty diff, gate it to
  `provider === 'gitlab'` and record the decision.
- **Q6 (resolved: default accepted): Changed-head-only PR-page refetch (NFR) for GitHub.** AC-48 freezes GitHub client
  behaviour. → **default:** GitLab only. GitHub detail keeps re-fetching on every PR page open, as
  today.
- **Q7 (resolved: default accepted): Deterministic e2e vs live gitlab.com.** The e2e must make no network calls. → **default:**
  add deploy config `DEVDIGEST_HOSTS_OFFLINE=true` (default `false`). When set, `container.prHost()`
  / `container.gitlab()` throw `ConfigError` before building any client, so every read path serves
  persisted data. `scripts/e2e.sh` sets it. The setting is not exposed in the UI.
- **Q8 (resolved: CHANGED by the user): git credentials for clone/fetch, both providers.** No
  token is ever embedded in a clone URL or written to a clone's `.git/config`, for **any**
  provider. `withGitHubToken` URL embedding is removed.
  - **Mechanism.** Credentials are supplied **per git invocation** as an `http.extraHeader`
    (`Authorization: Basic base64("<user>:<token>")`):
    - GitHub uses user `x-access-token` with `GITHUB_TOKEN`.
    - GitLab uses user `oauth2` with `GITLAB_TOKEN`.
    - A provider's token is never sent to the other host.
  - **Why Basic, not Bearer.** Git smart-HTTP on both hosts documents and supports Basic with these
    usernames for every token type in scope (classic and fine-grained PATs, GitLab
    personal/project/group tokens). Bearer on the git endpoint is not reliably accepted for every
    GitLab token type.
  - **Delivery channel (the safest practical option).** The header is injected through git's
    environment-config protocol (git ≥ 2.31): `GIT_CONFIG_COUNT=1`,
    `GIT_CONFIG_KEY_0=http.https://<host>/.extraHeader`, `GIT_CONFIG_VALUE_0=Authorization: Basic …`.
    The trade-offs:
    - `-c http.extraHeader=…` would put the credential in **argv**, which any local user can read
      via `ps` / `/proc/<pid>/cmdline`. Env vars are visible only to the same uid or root
      (`/proc/<pid>/environ`), never written to disk, and scoped to the one child process.
    - `GIT_ASKPASS` would need a helper script on disk, plus a second env var carrying the secret
      anyway. That adds a file to manage and buys no isolation.
    - The URL-scoped key `http.https://github.com/.extraHeader` (resp. `gitlab.com`) means the
      header is only sent to the provider's own host, even if a redirect or submodule points
      elsewhere.
  - **Guards in the adapter.**
    - Strip `GIT_TRACE*`, `GIT_CURL_VERBOSE` and `GIT_TRACE_CURL` from the child env, because
      those would print headers.
    - Fail closed: no header plus an auth error, never a fallback to URL embedding when git
      < 2.31.
    - Run `redactSecret` over stderr/stdout with the raw token **and** the base64 header value.
  - **Legacy clones.** Existing clones whose `origin` URL already carries userinfo (today's
    GitHub clones) get `git remote set-url origin <tokenless canonical URL>` **before** the next
    fetch/refresh/sync, in place, with the same clone path (AC-47).
- **Q9 (resolved: default accepted): Clone-path namespace.** → **default:** GitLab clones go to `<cloneDir>/@gitlab.com/<ns…>/<name>`.
  `@` is outside `GITHUB_NAME_REGEX`, so no GitHub owner dir can ever collide with or nest inside it.
  GitHub stays at `<cloneDir>/<owner>/<name>` (AC-47).
- **Rec-1: write GitHub URL characterization tests first.** No existing test covers `parseRepoUrl`
  (`server/test` has no reference). T5 must commit GitHub-only cases (https, `.git`, trailing slash,
  SSH, SSRF `https://internal/github.com/a/b`, `..`, 3 segments) **before** touching the parser.
  That is what makes AC-11 checkable.
- **Rec-2: don't persist a `running` sync state.** Keep it in the in-memory coordinator (the spec
  says it must not survive a restart). Persist only `last_synced_at`, `last_attempt_at` and
  `last_sync_error`, and derive `sync_state`. The single-flight guarantee is per process. A
  multi-instance deployment needs a DB/advisory lock and belongs to the multi-user spec.
- **Rec-3: keep the PR-list rollup code where it is.** `server/INSIGHTS.md` says list columns
  belong in the handler. T9 only replaces the *sync* part of `GET /repos/:id/pulls` and moves the
  rollup into a private function inside the same file. Lifting it into a repository is out of scope.
- **Rec-4: let `doc-writer` handle docs.** After T22, update `server/docs/api-contracts.md`,
  `client/specs/pages.md` and `e2e/README.md` coverage (T21 covers the README table only).

## Affected modules & contracts

- **server / vendor shared**: new contract file + new port file, re-exported from the barrel. The
  same three files are mirrored byte-identically in `client/src/vendor/shared`.
- **server / adapters**: new `adapters/gitlab/` (REST + GraphQL over `fetch`). New
  `adapters/github/host.ts` (adapts `GitHubClient` to the read-side port). `adapters/git/simple-git.ts`
  becomes host-aware. `adapters/mocks.ts` gets a `MockGitLabClient` and a host-aware `MockGitClient`.
- **server / platform**: container (`gitlab()`, `prHost(provider)`, `prSync`), config (TTL,
  offline flag), `platform/redact.ts`.
- **server / db**: `repos` + `pull_requests` + `pr_files` columns, unique-index swap, one new
  migration.
- **server / modules**: `repos` (parse/identity/add/refresh/clone), `pulls` (sync coordinator,
  sync service, repository, list/page/sync/SSE/detail/comments routes), `polling` (through the
  coordinator), `settings` (GitLab test + status), `reviews` (diff-loader, run-executor,
  intent-deriver), `brief` (issue lookup), `smart-diff` (wiring rule), `repo-intel` / `conventions` /
  `project-context` (HostRepoRef threading only), `_shared/repo-ref.ts`.
- **client**: hooks/data layer, host link builder, PR list, PR detail, diff viewer, Add repo,
  Settings → API keys, Conventions links, i18n catalogs.
- **mcp**: tool description wording only.
- **e2e**: two new flows, a seed fixture hook, and `scripts/e2e.sh` env.
- **reviewer-core**: **unchanged**.
- **Contracts (all additive, new files; no existing schema edited):**
  - `server/src/vendor/shared/contracts/repo-host.ts`:
    - `RepoProvider` (`'github'|'gitlab'`), `RepoHost` (`'github.com'|'gitlab.com'`), `RepoSyncState`
      (`'idle'|'running'|'failed'`).
    - `RepoWithHost = Repo.extend({ provider, host, web_url, last_synced_at: nullish,
      last_attempt_at: nullish, sync_state, last_sync_error: nullish })`.
    - `PrMetaHost = PrMeta.extend({ is_draft: optional, stats_known: optional })`.
    - `PrFileHost = PrFile.extend({ previous_path: nullish, change_type: enum optional,
      patch_omitted: enum('too_large','collapsed').nullish() })`.
    - `IssueMetaHost = IssueMeta.extend({ labels: optional })`.
    - `PrDetailHost = PrDetail.extend({ is_draft, stats_known, files: PrFileHost[],
      files_omitted_by_host: optional })`.
    - `PrSyncTrigger` (`'fresh'|'started'|'joined'`), `PrListSync` (`{ trigger, state,
      last_synced_at, last_attempt_at, last_sync_error }`), `PrListPage` (`{ pulls: PrMetaHost[],
      sync: PrListSync }`), `PrSyncStartResult` (`{ trigger: 'started'|'joined' }`),
      `PrSyncDoneEvent` (`{ state, last_synced_at, last_sync_error }`).
    - `ConnTestProviderHost = z.enum([...ConnTestProvider.options, 'gitlab'])`, plus
      `ConnTestRequestHost` / `ConnTestResultHost` and
      `SecretsStatusHost = SecretsStatus.extend({ gitlab: z.boolean() })`.
    - `HostErrorCode` enum: `gitlab_token_missing | gitlab_token_invalid |
      gitlab_project_inaccessible | unsupported_repo_host | provider_read_only`.
  - `server/src/vendor/shared/host-adapters.ts`:
    - `HostRepoRef extends RepoRef { provider; host; fullName }`.
    - `PullRequestHost` (read-side port, named after the conversation, not the vendor):
      `provider`, `readOnly`, `listPullRequests`, `getPullStates`, `getPullRequestDetail(ref, n,
      { unlessHeadSha })` → `{ kind:'full', detail } | { kind:'unchanged', meta }`, `getIssue`,
      `getLinkedIssueNumber`.
    - `GitLabClient extends PullRequestHost` with `getProject(fullPath)` and `checkToken()`, plus
      `GitLabProjectInfo` and `GitLabTokenCheck`.
  - `server/src/vendor/shared/index.ts`: **two added `export *` lines only**. This is the barrel's
    documented extension mechanism. *Callout:* it is an edit to an existing shared file, but it is
    additive and done in lockstep with the client copy.
  - The existing `GitHubClient`, `GitClient`, `RepoRef`, `Repo`, `PrMeta`, `PrDetail`, `ConnTest*`
    and `SecretsStatus` are **not edited**. `GitClient` methods keep taking `RepoRef`, and
    `HostRepoRef` is a structural subtype passed through them.

## Architecture changes

- **Core (contracts/ports)**: the two new files above. Port naming follows onion §3
  (`PullRequestHost`, not `GitLabApi`).
- **Infrastructure / adapters**:
  - `adapters/gitlab/http.ts`: base `https://gitlab.com` only, `redirect:'manual'` (any 3xx is an
    error), 15 s `AbortSignal.timeout`, retry 429/5xx ×3 at 1/2/4 s ±20 % jitter, `Retry-After`
    capped at 30 s, total extra wait ≤ 60 s. `PRIVATE-TOKEN` header only when a token exists. All
    error messages go through `redactSecret`. Injectable `fetch` / `sleep` / `random`.
  - `adapters/gitlab/graphql.ts`: the open-MR page query (`project(fullPath).mergeRequests(state:
    opened, first:100, after)` with `iid title draft state sourceBranch targetBranch diffHeadSha
    createdAt updatedAt author{username} diffStatsSummary{additions deletions fileCount}`), plus the
    `iids:[…]` state query.
  - `adapters/gitlab/client.ts`: `RestGitLabClient implements GitLabClient` (REST:
    `/projects/:path`, `/merge_requests/:iid`, `/diffs`, `/commits`, `/closes_issues`,
    `/issues/:iid`, `/user`, `/personal_access_tokens/self`).
  - `adapters/gitlab/mappers.ts`: vendor → domain (the anti-corruption layer).
  - `adapters/github/host.ts`: `GitHubPullRequestHost` wraps the existing `GitHubClient`, with no
    behaviour change.
  - `adapters/git/simple-git.ts`: host-aware `clonePathFor` with a containment check,
    `fetchPullHead` (GitHub `pull/<n>/head`, GitLab `merge-requests/<iid>/head`), and redacted
    errors. **Credentials (Q8):** an injected `GitCredentialResolver` supplies
    `{username, token}` per `HostRepoRef`. Every network op (clone, fetch, `sync`, `fetchPullHead`)
    gets a host-scoped `http.extraHeader` through `GIT_CONFIG_*` env (never argv, never the URL).
    Any userinfo found in an existing `origin` URL is rewritten to the tokenless canonical URL
    before fetching.
- **Infrastructure / db**: a new migration adds these columns:
  - `repos.provider text not null default 'github' check in ('github','gitlab')`.
  - `repos.host text not null default 'github.com'`.
  - `repos.last_synced_at timestamptz`, `repos.last_attempt_at timestamptz`,
    `repos.last_sync_error text`.
  - Drop `repos_ws_fullname_uq`, create `repos_ws_provider_host_fullname_uq (workspace_id, provider,
    host, full_name)`.
  - `pull_requests.is_draft boolean`, `stats_known boolean`, `detail_head_sha text`.
  - `pr_files.previous_path text`, `change_type text`, `patch_omitted text`.
  
  `web_url` is **derived** (`https://<host>/<full_name>`), not stored.
- **Application**:
  - `modules/pulls/sync-coordinator.ts`: `PrSyncCoordinator`, a container singleton.
    `Map<repoId, inflight>` drives `onOpen` (TTL/back-off/join/start) and `manual` (join/start).
    Each sync is a detached promise (survives the request). `onDone(repoId, cb)` and
    `isRunning(repoId)` are exposed.
  - `modules/pulls/sync-service.ts`: `PrListSyncService.syncRepo(repo)` selects the host by
    `repo.provider`, then upserts. For GitLab it reconciles MRs that left the open set; for GitHub it
    backfills ≤ 10 zero-stat PRs **sequentially**. Explicit deps object, no `Container`.
  - `modules/pulls/detail-service.ts`: `PullDetailService`, provider-aware detail refresh
    (head-unchanged short-circuit for GitLab) plus `assertWritable(repo)`.
- **Infrastructure / repositories**: `modules/pulls/repository.ts` gets `upsertListWithStats`,
  `listOpenNumbers`, `updateStatuses` and `replaceDetail(tx)`. New
  `modules/pulls/sync-status-repository.ts` reads and writes the repos sync columns.
  `modules/repos/repository.ts` gets `findByIdentity(ws, provider, host, fullName)` (lower() for
  GitLab), `list` ordered by `created_at`, and an insert with provider/host.
- **Presentation**: `modules/pulls/routes.ts`:
  - `GET /repos/:id/pulls` (unchanged shape, sync-on-open).
  - `GET /repos/:id/pulls/page`, `POST /repos/:id/pulls/sync`, `GET /repos/:id/pulls/sync/events`
    (SSE, one `done`).
  - `GET /pulls/:id` via `PullDetailService`.
  - Comments GET/POST read-only for GitLab.
  
  `modules/polling/routes.ts`: `POST /repos/:id/poll` = manual sync awaited through the
  coordinator (response shape unchanged). `modules/settings/routes.ts` uses the `ConnTestRequestHost`
  body plus a `gitlab` branch.
- **Composition root**: `platform/container.ts`:
  - The `git` getter passes a `GitCredentialResolver` to `SimpleGitClient`: `github` →
    `GITHUB_TOKEN` / `x-access-token`, `gitlab` → `GITLAB_TOKEN` / `oauth2`, resolved through
    `SecretsProvider` at each call, so a rotated token applies immediately.
  - `gitlab()` (token optional, cached).
  - `prHost(provider)`.
  - `prSync` getter.
  - `ContainerOverrides.gitlab`, `ContainerOverrides.prSyncClock`.
  - `invalidateSecretCaches()` clears `_gitlab`.
  - `intent` / `briefService` deps gain `prHost`.
  
  `platform/config.ts`: `PR_SYNC_TTL_SECONDS` (default 60, used for both TTL and back-off) and
  `DEVDIGEST_HOSTS_OFFLINE`.
- **Client (RSC boundary)**: all touched screens are already `"use client"`, and no new server
  components are added. Data stays in TanStack Query. The SSE completion signal is a raw
  `EventSource` in a hook (the same pattern as RunTraceDrawer), outside `api.ts`.

## Phased tasks

### Phase 1: Contracts & independent edits *(T1 ∥ T2 ∥ T14 ∥ T15)*

- **T1: Shared contracts, port file and server-side pure primitives**
  - **Action:**
    - Create `contracts/repo-host.ts` and `host-adapters.ts` exactly as listed under "Affected
      modules & contracts". Every new optional field uses `.optional()` / `.nullish()`, never a bare
      `.nullable()`.
    - Add the two `export *` lines to `index.ts`, then copy all three files byte-identically into
      `client/src/vendor/shared/`.
    - Add `server/src/modules/_shared/repo-ref.ts` with:
      - `hostRepoRef(row: {owner,name,fullName,provider?,host?}): HostRepoRef` (missing provider →
        `github`/`github.com`).
      - `repoWebUrl(provider, host, fullName)`.
      - `cloneRemoteUrl(provider, fullName)` → `https://github.com/<fn>.git` |
        `https://gitlab.com/<fn>.git` (always tokenless).
    - In `host-adapters.ts`, also declare `GitCredential { username: string; token: string }` and
      `GitCredentialResolver = (ref: HostRepoRef) => Promise<GitCredential | null>` (Q8).
    - Add `server/src/platform/redact.ts` with `redactSecret(text, ...secrets)`. It replaces each
      non-empty secret, its `base64("<user>:<secret>")` form for both known usernames, any
      `//user:pass@` userinfo, and any `Authorization: Basic|Bearer <…>` value with `***`.
  - **Module:** server (+ client vendor copy)
  - **Type:** backend
  - **Skills to use:** zod, typescript-expert, onion-architecture, security
  - **Owned paths:** `server/src/vendor/shared/contracts/repo-host.ts`, `server/src/vendor/shared/host-adapters.ts`, `server/src/vendor/shared/index.ts`, `client/src/vendor/shared/contracts/repo-host.ts`, `client/src/vendor/shared/host-adapters.ts`, `client/src/vendor/shared/index.ts`, `server/src/modules/_shared/repo-ref.ts`, `server/src/platform/redact.ts`, `server/test/contracts-repo-host.test.ts`, `server/test/repo-ref.test.ts`
  - **Depends-on:** none
  - **Risk:** medium (every downstream task compiles against it)
  - **Known gotchas:**
    - The shared copies are vendored twice, and CI `shared-sync.yml` fails on any byte drift. Edit
      server first, then `cp` to client.
    - A `.nullable()` field makes the key required and breaks every fixture that builds the object
      (root `INSIGHTS.md`).
    - ZodError is matched by shape, not `instanceof` (duplicate zod).
    - Do **not** touch `platform.ts` / `adapters.ts`.
  - **Acceptance:**
    - `node scripts/check-shared-sync.mjs` → `✓ … in sync`.
    - `cd server && pnpm typecheck && pnpm vitest run test/contracts-repo-host.test.ts test/repo-ref.test.ts` passes. The tests cover:
      - `RepoWithHost.parse` accepts a migrated GitHub DTO (`provider:'github'`), and `Repo.parse`
        still accepts the old shape.
      - `PrMetaHost.parse` of an existing `PrMeta` fixture passes unchanged.
      - `ConnTestRequestHost.parse({provider:'gitlab'})` passes, and the old `ConnTestRequest`
        rejects `gitlab`.
      - `redactSecret('https://oauth2:glpat-x@gitlab.com', 'glpat-x')` contains no `glpat-x`.
      - `redactSecret('Authorization: Basic ' + b64('oauth2:glpat-x'), 'glpat-x')` contains
        neither the token nor the base64 value.
    - `cd client && pnpm typecheck` passes.

- **T2: DB schema columns + migration (add-only)**
  - **Action:**
    - Add the columns and the unique-index swap listed in "Architecture changes" to
      `db/schema/repos.ts`, `db/schema/pulls.ts` (`pullRequests`, `prFiles`).
    - Generate the migration with `cd server && pnpm db:generate`. Do not hand-write it; review the
      SQL instead. It must contain `ADD COLUMN … DEFAULT 'github' NOT NULL`, a CHECK on provider,
      `DROP INDEX "repos_ws_fullname_uq"` and the new unique index.
    - Write `server/test/repo-host-migration.it.test.ts`. On a seeded DB: snapshot repo/pr/review/
      finding ids, `full_name` and `clone_path` before and after migration, and assert provider/host
      were backfilled.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** drizzle-orm-patterns, postgresql-table-design, onion-architecture
  - **Owned paths:** `server/src/db/schema/repos.ts`, `server/src/db/schema/pulls.ts`, `server/src/db/migrations/0019_*.sql`, `server/src/db/migrations/meta/_journal.json`, `server/src/db/migrations/meta/0019_snapshot.json`, `server/test/repo-host-migration.it.test.ts`
  - **Depends-on:** none
  - **Risk:** medium
  - **Known gotchas:**
    - Never edit applied migrations `0000–0018`.
    - Migrations are not auto-run on boot (`pnpm db:migrate`).
    - It-tests that insert repos must use unique full_names (`server/INSIGHTS.md`,
      `repos_ws_fullname_uq` → now the new index name).
    - Keep `provider` as TEXT + CHECK, not a PG enum (the skill rules this an evolving set).
  - **Acceptance:**
    - `cd server && pnpm db:generate` produces exactly one new `0019_*.sql`.
    - `pnpm vitest run test/repo-host-migration.it.test.ts` passes: row counts and ids unchanged,
      every repo has `provider='github'` and `host='github.com'` (AC-46).
    - Inserting two rows `(ws,'github','github.com','acme/web')` and `(ws,'gitlab','gitlab.com','acme/web')` succeeds, and a third duplicate github row violates the unique index (AC-15/AC-16 at DB level).

- **T14: Smart Diff `.gitlab/` wiring rule**
  - **Action:** In `smart-diff/constants.ts`, add `WIRING_PATH_PREFIXES = ['.github/', '.gitlab/']`
    (keep `WIRING_PATH_PREFIX` exported for compatibility) and `WIRING_BASENAMES` containing
    `.gitlab-ci.yml`. In `helpers.ts`, match any prefix or basename.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** typescript-expert, onion-architecture
  - **Owned paths:** `server/src/modules/smart-diff/constants.ts`, `server/src/modules/smart-diff/helpers.ts`, `server/test/smart-diff-gitlab.test.ts`
  - **Depends-on:** none
  - **Risk:** low
  - **Known gotchas:** `.gitlab-ci.yml` is probably already caught by the YAML-suffix rule. Assert
    the classification explicitly anyway, so a future YAML-rule change can't regress AC-35.
  - **Acceptance:**
    - `pnpm vitest run test/smart-diff-gitlab.test.ts`: `.gitlab-ci.yml` → `wiring`,
      `.gitlab/issue_templates/bug.md` → `wiring`, `src/gitlab.ts` → not wiring.
    - `pnpm vitest run test/smart-diff-helpers.test.ts` passes unmodified (AC-35).

- **T15: MCP provider-neutral wording**
  - **Action:** Reword the PR-number `.describe(...)` in `run-agent-on-pr.ts` (and any sibling tool
    that says "as shown on GitHub") to "Pull request number as shown in DevDigest (GitHub PR number
    or GitLab MR iid), e.g. 482 — not an internal uuid."
  - **Module:** mcp
  - **Type:** backend
  - **Skills to use:** typescript-expert
  - **Owned paths:** `mcp/src/tools/run-agent-on-pr.ts`, `mcp/src/tools/get-findings.ts`, `mcp/src/tools/get-blast-radius.ts`
  - **Depends-on:** none
  - **Risk:** low
  - **Known gotchas:** MCP is a thin HTTP proxy. Don't change any URL or param name.
  - **Acceptance:**
    - `cd mcp && pnpm typecheck && pnpm test` passes.
    - `grep -rn "as shown on GitHub" mcp/src` returns nothing (AC-42).

### Phase 2: Adapters, cores, client data layer *(T3 ∥ T6 ∥ T7 ∥ T8 ∥ T16 ∥ T17; all after T1, and T7/T8/T16 also after T2)*

- **T3: GitLab adapter (REST + GraphQL) and test doubles**
  - **Action:**
    - Implement `adapters/gitlab/{http,graphql,client,mappers,index}.ts` per "Architecture
      changes".
    - Mappers:
      - State: `opened|locked→open`, `merged→merged`, `closed→closed` (AC-19). Draft from `draft`
        (AC-50).
      - `diffStatsSummary` null → `stats_known:false` with zeros. **Never** use `changes_count`
        (AC-20/54).
      - Files: `new_file→added`, `deleted_file→deleted`, `renamed_file→renamed` + `previous_path`
        (`old_path`). `too_large`/`collapsed` → `patch_omitted` with `patch:null` (AC-24).
        `diff` → patch.
      - `diffHeadSha` null → fall back to the MR `sha`, or `''`.
    - `listPullRequests`: walk GraphQL `pageInfo` to the end. One request per page carries
      metadata + stats (AC-18/20/22).
    - `getPullStates`: GraphQL `iids:` in chunks of 100.
    - `getPullRequestDetail`: `GET /merge_requests/:iid`. If `sha === unlessHeadSha`, return
      `unchanged`. Otherwise page `/diffs?per_page=100` and `/commits?per_page=100` to the last page
      (`x-next-page`), with no cap (AC-21/22). Compute `files_omitted_by_host`.
    - `getLinkedIssueNumber`: `/closes_issues`, filtered to `project_id === project.id`, first iid
      or null.
    - `getIssue` → title/description/state/labels (AC-23).
    - `getProject`:
      - 404 without a token → `AppError('gitlab_token_missing', 'Connect a GitLab token in Settings …', 400)`.
      - 404/403 with a token → `gitlab_project_inaccessible` ("project not found or token has no
        access", 404).
      - 401 → `gitlab_token_invalid` (AC-13/14).
    - `checkToken`:
      - `/user` → username. 401 → invalid / expired / revoked, parsed from `error_description`, and
        never echoed (AC-2/3).
      - `/personal_access_tokens/self` scopes → missing `read_api`/`read_repository` unless `api`
        is present (AC-4).
      - 404/403 on that endpoint → `scopes:null` (AC-5).
    - In `adapters/mocks.ts`:
      - Add `MockGitLabClient` (configurable MRs/stats/files/errors, plus a `calls` recorder by
        endpoint kind).
      - Make `MockGitClient.clonePathFor` host-aware (mirroring T6's rule).
      - Make `MockGitClient` record `fetchPullHead` calls.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, typescript-expert, zod, security
  - **Owned paths:** `server/src/adapters/gitlab/**`, `server/src/adapters/mocks.ts`, `server/test/gitlab-http.test.ts`, `server/test/gitlab-client.test.ts`, `server/test/fixtures/gitlab/**`
  - **Depends-on:** T1
  - **Risk:** high (vendor API shape, pagination, error mapping)
  - **Known gotchas:**
    - No Fastify imports in adapters (`no-fastify-in-adapters` is an **error** rule).
    - Don't reuse `platform/resilience.withRetry`. Its 250 ms base / 8 s cap doesn't meet the NFR,
      so build the GitLab policy in `http.ts`.
    - Project path in REST must be `encodeURIComponent(fullPath)` (slashes → `%2F`).
    - Use `redirect:'manual'`. A cross-host redirect must throw, never follow.
    - `MockGitClient.readFile` returns `''` for missing files (`server/INSIGHTS.md`). Leave that
      behaviour alone.
  - **Acceptance:** `cd server && pnpm vitest run test/gitlab-http.test.ts test/gitlab-client.test.ts` passes, using an injected fake `fetch` and fake `sleep`. Cases:
    - 120 open MRs → 2 GraphQL requests, 0 `/diffs` / `/commits` requests, all 120 mapped (AC-18/20/22).
    - Null `diffStatsSummary` → `stats_known:false` (AC-54).
    - `locked` → `open` (AC-19).
    - An MR with 1 200 files over 12 diff pages → 1 200 `PrFileHost` (AC-22).
    - A `too_large` file → `patch_omitted:'too_large'`, `patch:null` (AC-24).
    - Renamed file → `change_type:'renamed'`, `previous_path` set (AC-33).
    - Detail fetch with `unlessHeadSha` equal to the host SHA → `kind:'unchanged'` and no diff
      request.
    - 429 with `Retry-After: 2` → sleeps 2 s and succeeds. 5xx ×4 → 3 retries with delays
      1/2/4 s ±20 %, then throws.
    - A 302 to `evil.example` throws.
    - Every thrown message for token `glpat-SECRET` lacks `glpat-SECRET`.
    - `checkToken` scenarios: valid → username, `read_user`-only → missing scopes listed, scopes
      endpoint 404 → `scopes:null`, 401 "Token has expired." → reason `expired` (AC-2–5).
    - `getProject` 404 with/without token → the two distinct codes (AC-13/14).

- **T6: Host-aware git adapter**
  - **Action:** In `SimpleGitClient`:
    - `clonePathFor(ref)`:
      - GitHub (no provider, or `github`) → `join(cloneDir, owner, name)`, **unchanged**.
      - GitLab → `join(cloneDir, '@gitlab.com', ...owner.split('/'), name)`.
      - Then `resolve()` the result and assert it starts with `resolve(cloneDir) + sep`, otherwise
        throw.
    - Constructor: `new SimpleGitClient(cloneDir, { credentials?: GitCredentialResolver,
      gitFactory? })`. `gitFactory` is a test seam wrapping `simpleGit(dir)`.
    - **Credentials (Q8), for every network op** (`clone`, the existing-clone `fetch`, `sync`,
      `fetchPullHead`):
      - Resolve `credentials(ref)`. If it returns a credential, run that one git child with env
        `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.https://<host>/.extraHeader`,
        `GIT_CONFIG_VALUE_0=Authorization: Basic <base64(user:token)>`.
      - Remove `GIT_TRACE`, `GIT_TRACE_CURL`, `GIT_CURL_VERBOSE` and `GIT_TRACE_PACKET` from that
        env.
      - Never put the credential in argv or in the remote URL. Never call `git config` to
        persist it.
      - Check `git --version` ≥ 2.31 once. If it is older, run **without** a header (fail closed,
        so private repos fail with an auth error). Never fall back to URL embedding.
    - **Tokenless remotes:** `clone` receives a tokenless URL (reject one carrying userinfo).
      Before any fetch on an existing clone (`clone` with `.git` present, `sync`, `fetchPullHead`),
      read `remote.origin.url`. If it contains userinfo, `git remote set-url origin
      <cloneRemoteUrl(provider, fullName)>`. This rewrites legacy GitHub clones in place, with the
      same path (AC-47).
    - `clone` for GitLab: `mkdir` the nested parent.
    - `fetchPullHead(ref, n)`: GitHub `pull/<n>/head:pr-<n>` (unchanged). GitLab
      `+refs/merge-requests/<n>/head:refs/devdigest/mr-<n>` plus `origin <base>` with
      `--depth 50` (AC-30).
    - Wrap git errors so messages (stderr/stdout) pass through `redactSecret(msg, token)`, which
      covers the raw token, the base64 header value and userinfo.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, security, typescript-expert
  - **Owned paths:** `server/src/adapters/git/simple-git.ts`, `server/test/simple-git-host-paths.test.ts`, `server/test/simple-git-credentials.test.ts`
  - **Depends-on:** T1
  - **Risk:** medium
  - **Known gotchas:**
    - The adapter must read `provider` structurally (`'provider' in ref`), because the port still
      types `RepoRef`.
    - `GIT_TERMINAL_PROMPT=0` is already set, so private clones fail fast.
    - simple-git's `.env()` *replaces* the child env and its unsafe-env plugin rejects some
      inherited vars (see the constructor comment in `simple-git.ts`). Build the env per call as
      `process.env` minus the keys simple-git refuses and minus `GIT_TRACE*`, plus the
      `GIT_CONFIG_*` triple. Never write the secret into `process.env`.
    - The resolver is called per invocation, never cached, so a rotated token applies at once.
    - Don't change the GitHub path or the depth-1 clone.
    - `fetchPullHead` is currently never called (grep), so no GitHub behaviour changes.
  - **Acceptance:** `pnpm vitest run test/simple-git-host-paths.test.ts` passes (temp-dir based, no network). Cases:
    - `{owner:'acme',name:'web'}` → `<dir>/acme/web` (AC-47).
    - The GitLab twin → `<dir>/@gitlab.com/acme/web` (AC-15).
    - `a/b/c/d` + `e` → nested.
    - A crafted owner `../x` throws.
    - A git error containing `oauth2:tok@` is redacted.
  - **Acceptance (credentials, Q8):** `pnpm vitest run test/simple-git-credentials.test.ts`. It
    uses a temp local bare repo as `origin`, plus a `gitFactory` spy to observe the env and argv of
    each git call.
    - Clone, then refresh (`clone` again), `sync` and `fetchPullHead`: every network call's env
      carries `GIT_CONFIG_KEY_0=http.https://<host>/.extraHeader`, and **no** argv element contains
      the token or its base64 value.
    - **After clone + refresh, `<clone>/.git/config` contains neither the token, nor its base64
      form, nor any `user@` userinfo**, read from disk and checked with substring asserts.
    - A pre-existing clone whose origin is `https://x-access-token:tok@github.com/acme/web.git` has
      origin = `https://github.com/acme/web.git` after the next fetch, and the clone path is
      unchanged (AC-47).
    - A GitHub ref never gets the GitLab credential and vice versa (the resolver is called with the
      ref's provider).
    - With `GIT_TRACE=1` in `process.env`, the child env has no `GIT_TRACE`.
    - A git error whose stderr contains the header value is redacted.

- **T7: Thread `HostRepoRef` through the remaining GitClient call sites**
  - **Action:**
    - Replace every `{ owner: repo.owner, name: repo.name }` RepoRef literal with
      `hostRepoRef(row)` in repo-intel (service ×3, pipeline full/incremental), conventions service
      and project-context service.
    - Extend the narrow selects (`RepoIntelRepository.getRepoBasics`, `RepoBasics` type,
      `ConventionsRepository.getRepo`) with `provider`, `host` and `fullName`.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, drizzle-orm-patterns, typescript-expert
  - **Owned paths:** `server/src/modules/repo-intel/service.ts`, `server/src/modules/repo-intel/pipeline/full.ts`, `server/src/modules/repo-intel/pipeline/incremental.ts`, `server/src/modules/repo-intel/repository.ts`, `server/src/modules/repo-intel/types.ts`, `server/src/modules/conventions/service.ts`, `server/src/modules/conventions/repository.ts`, `server/src/modules/project-context/service.ts`, `server/test/host-ref-threading.test.ts`
  - **Depends-on:** T1, T2
  - **Risk:** medium (wide but mechanical)
  - **Known gotchas:**
    - `repo-intel` carries the biggest `pnpm arch` warning backlog, including cycles. Add **no** new
      imports other than `../_shared/repo-ref.js`.
    - `_shared` is the one slice everything may import.
  - **Acceptance:**
    - `grep -rn "owner: repo.owner, name: repo.name" server/src/modules/{repo-intel,conventions,project-context}` → no matches.
    - `pnpm vitest run test/host-ref-threading.test.ts`: a GitLab-row repo-intel index call
      reaches the `MockGitClient` with `provider:'gitlab'`.
    - Existing `test/indexer-pipeline.test.ts`, `test/repo-intel-*.test.ts`,
      `test/conventions*.test.ts` and `test/project-context-*.test.ts` pass unmodified (AC-12).

- **T8: Sync coordinator, sync service, PR repositories**
  - **Action:**
    - `PrSyncCoordinator({ ttlMs, backoffMs, now, status, run })`:
      - `onOpen(repo)`: running → `joined`. `last_synced_at` within TTL → `fresh`. Last attempt
        failed within back-off → `fresh`. Otherwise start → `started`.
      - `manual(repo)`: join or start.
      - `start` runs `run(repo)` as a detached promise with `.catch`. On completion it persists
        `last_attempt_at = now`, plus `last_synced_at = now` and `error=null` on success, or a
        redacted human-readable `last_sync_error` on failure. Then it notifies `onDone` listeners
        and deletes the in-flight entry.
      - Also exposes `isRunning`, `snapshot(repo)` → `PrListSync`, and `awaitRunning(repoId)`.
    - `PrListSyncService({ hosts:(p)=>Promise<PullRequestHost>, store, statusRepo })`:
      - `syncRepo(repoRow)`: GitHub → `listPullRequests`, then `upsertList` (unchanged rule), then
        sequential backfill of ≤ 10 zero-stat rows via `getPullRequestDetail` + `updateDiffStats`.
      - GitLab → `listPullRequests`, then `upsertListWithStats` (also refreshes
        `is_draft`/`stats_known`/stats when known, and keeps the old stats when the new ones are
        unknown). Then `listOpenNumbers` minus the returned set → `getPullStates` →
        `updateStatuses` (AC-28).
      - At most one host request in flight at a time.
    - Repository additions per "Architecture changes", plus the new
      `sync-status-repository.ts` (`get`, `recordSuccess`, `recordFailure`). All methods take an
      optional `tx` and are scoped by workspace.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, drizzle-orm-patterns, typescript-expert, security
  - **Owned paths:** `server/src/modules/pulls/sync-coordinator.ts`, `server/src/modules/pulls/sync-service.ts`, `server/src/modules/pulls/repository.ts`, `server/src/modules/pulls/sync-status-repository.ts`, `server/test/pr-sync-coordinator.test.ts`, `server/test/pr-sync-service.test.ts`, `server/test/pr-sync-repository.it.test.ts`
  - **Depends-on:** T1, T2
  - **Risk:** high (concurrency semantics drive AC-55–64)
  - **Known gotchas:**
    - Keep the existing `upsertList` semantics byte-for-byte. Stats are not overwritten for GitHub
      (`pulls/repository.ts:47-88`), and `test/pull-request-repository.it.test.ts` must pass
      unmodified.
    - Extend the `PullRequestStore` interface (server-internal), and update any test fake that
      implements it.
    - Use an injected clock, never `Date.now()` directly. `running` is never persisted (Rec-2).
    - A sync must not be cancelled by request close (AC-64), so never tie it to `req.raw`.
  - **Acceptance:** `cd server && pnpm vitest run test/pr-sync-coordinator.test.ts test/pr-sync-service.test.ts test/pr-sync-repository.it.test.ts` passes. Cases:
    - Open at t=61 s after success → exactly 1 run, trigger `started` (AC-56).
    - Two opens 30 s apart after success → 0 runs (AC-61).
    - Host rejecting, 10 opens within 60 s → 1 run (AC-62).
    - 10 concurrent opens during a 20 s fake run → 1 run, 9 `joined`, and all 10 `onDone`
      listeners fire (AC-57).
    - Manual at 5 s after success → new run. 5 manual calls during a run → 1 run + 4 `joined`
      (AC-58).
    - The run completes after the caller discarded its promise → `last_synced_at` persisted, and a
      re-open within the TTL → `fresh` (AC-64).
    - GitLab sync with a host whose detail/diff methods throw if called → succeeds with 0 detail
      calls (AC-18).
    - A persisted open MR missing from the list → status updated to `merged` (AC-28).
    - GitHub host failing does not affect a parallel GitLab repo sync (AC-27).
    - Stats-unknown upsert leaves `stats_known=false`, and a later known upsert fills the numbers
      (AC-54).
    - Persisting one 100-MR page takes p95 ≤ 200 ms over 20 iterations on testcontainers (NFR
      per-page).

- **T16: GitLab seed fixture (server)**
  - **Action:**
    - New `server/src/db/seed-gitlab.ts`, called from `seed.ts` **after** the GitHub demo repo,
      only when `SEED_GITLAB_FIXTURE=1`. It inserts repo `space-profit/platform/crm-frontend`
      (`provider gitlab`, `host gitlab.com`) and PR #5:
      - draft, `stats_known=true`, `detail_head_sha = head_sha`;
      - files: one renamed (`previous_path`), one `patch_omitted='too_large'`, one normal with a
        patch;
      - 2 commits.
    - Also insert PR #6 with `stats_known=false`, plus `last_synced_at = now()`. Idempotent, like
      the existing seed.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** drizzle-orm-patterns, typescript-expert
  - **Owned paths:** `server/src/db/seed-gitlab.ts`, `server/src/db/seed.ts`, `server/test/seed-gitlab.it.test.ts`
  - **Depends-on:** T2
  - **Risk:** low
  - **Known gotchas:**
    - e2e flows 02/04/05 assume the seeded GitHub repo is *first*. Insert the GitLab repo later,
      and keep it env-gated so the default `pnpm db:seed` output is unchanged.
    - The seed creates reviews but no `agent_runs` (`server/INSIGHTS.md`).
  - **Acceptance:** `pnpm vitest run test/seed-gitlab.it.test.ts`:
    - Running seed twice with the flag → exactly 1 GitLab repo and 2 PRs.
    - Without the flag → no GitLab rows.

- **T17: Client data layer: hooks, types, host link builder, sync completion**
  - **Action:**
    - `lib/types.ts`: re-export the new contract types.
    - `lib/host-urls.ts`: `hostPrUrl(repo, n)`, `hostBlobUrl(repo, sha, path, a?, b?)`,
      `hostLabelKey(repo)`.
      - GitHub delegates to the **unchanged** `github-urls.ts`.
      - GitLab uses `repo.web_url` → `/-/merge_requests/<n>`, `/-/blob/<sha>/<path>#L<a>[-<b>]`.
      - Only `https:` URLs whose host equals `repo.host` are returned; anything else → null.
    - `lib/hooks/core.ts`:
      - `usePullsPage(repoId)` (`GET /repos/:id/pulls/page`, key `["pulls", repoId]`). `usePulls`
        = the same key with `select: p => p.pulls`.
      - **Remove `refetchInterval: 60_000`** and set `refetchOnWindowFocus:false` (AC-63).
      - `useSyncPulls()` mutation (`POST /repos/:id/pulls/sync`).
      - `useRepos` typed `RepoWithHost[]`.
      - `useSecretsStatus` / `useTestConnection` typed with the `*Host` contracts.
    - `lib/hooks/pr-sync.ts`: `usePrSyncCompletion(repoId, active)` opens one `EventSource` on
      `${API_BASE}/repos/:id/pulls/sync/events` while `active`. On the `done` event it calls
      `es.close()` and invalidates `["pulls", repoId]` **once**. On `error` it calls `es.close()`
      with no retry. It closes on unmount.
  - **Module:** client
  - **Type:** ui
  - **Skills to use:** next-best-practices, react-best-practices, react-testing-library, typescript-expert, frontend-ui-architecture
  - **Owned paths:** `client/src/lib/types.ts`, `client/src/lib/host-urls.ts`, `client/src/lib/host-urls.test.ts`, `client/src/lib/hooks/core.ts`, `client/src/lib/hooks/pr-sync.ts`, `client/src/lib/hooks/pr-sync.test.tsx`, `client/src/lib/hooks/core.pulls.test.tsx`, `client/src/lib/hooks/index.ts`
  - **Depends-on:** T1
  - **Risk:** medium
  - **Known gotchas:**
    - A raw `EventSource` **auto-reconnects** when the server closes the stream. Always call
      `close()` on `done`/`error`, or the hook degrades into periodic polling, violating AC-63.
    - The detail page resolves number→uuid from the cached `["pulls", repoId]` list (client
      `CLAUDE.md`). Keep the same query key so that still works.
    - `fetch` is mocked in client tests (no API).
  - **Acceptance:** `cd client && pnpm typecheck && pnpm test -- src/lib` passes. Cases:
    - host-urls: GitLab MR / blob / line / range hrefs match AC-37 literally. GitHub outputs equal
      `githubPrUrl` / `githubBlobUrl` for the same inputs (AC-38). A `javascript:` or foreign-host
      `web_url` → null.
    - pr-sync with fake timers: one `done` → exactly 1 list refetch, then 0 further requests over
      `advanceTimersByTime(600_000)` (AC-63).
    - core.pulls: no `refetchInterval` on the pulls query.

### Phase 3: Composition root *(T4 alone; after T1, T3, T6)*

- **T4: Container wiring for hosts + GitHub read-side host**
  - **Action:**
    - New `adapters/github/host.ts`: `GitHubPullRequestHost(gh)` implementing `PullRequestHost` by
      delegation:
      - `listPullRequests` → `gh.listPullRequests`.
      - `getPullStates` → `[]` (the list is state=all).
      - `getPullRequestDetail` → always `full`.
      - `getIssue` and `getLinkedIssueNumber` → `null`.
      - `readOnly:false`.
    - Container additions:
      - `ContainerOverrides.gitlab?: GitLabClient`.
      - `async gitlab()`: offline flag → `ConfigError`. Otherwise read the `GITLAB_TOKEN` secret
        (optional) and cache.
      - `async prHost(provider)`: offline → `ConfigError`. `'github'` → wraps `this.github()`,
        `'gitlab'` → `this.gitlab()`.
      - `invalidateSecretCaches()` also clears `_gitlab`.
      - `get git()` passes `{ credentials: (ref) => … }` to `SimpleGitClient`. `github` →
        `GITHUB_TOKEN` as `x-access-token`, `gitlab` → `GITLAB_TOKEN` as `oauth2`, a missing
        secret → `null` (anonymous). Read via `SecretsProvider` on every call (Q8).
    - `config.ts`: `DEVDIGEST_HOSTS_OFFLINE` → `hostsOffline: boolean`.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, typescript-expert, security
  - **Owned paths:** `server/src/adapters/github/host.ts`, `server/src/platform/container.ts`, `server/src/platform/config.ts`, `server/test/container-hosts.test.ts`
  - **Depends-on:** T1, T3, T6
  - **Risk:** medium (hot file, the first of a serial chain T4 → T9 → T10)
  - **Known gotchas:**
    - Only the container may `new RestGitLabClient`.
    - Keep `github()` exactly as-is, since eval-ci and the comment paths use it.
    - Secrets go only through `SecretsProvider`, never `process.env`.
  - **Acceptance:** `pnpm vitest run test/container-hosts.test.ts`:
    - `prHost('gitlab')` with no token builds an anonymous client.
    - `prHost('github')` without `GITHUB_TOKEN` rejects, while `prHost('gitlab')` still resolves
      (AC-27).
    - With `hostsOffline` both reject with `ConfigError` and no fetch.
    - An override wins.
    - `secrets.get` is never called with `GITHUB_TOKEN` when building the GitLab client (AC-13).
    - The git credential resolver returns `{username:'oauth2', token:<GITLAB_TOKEN>}` for a GitLab
      ref and `{username:'x-access-token', token:<GITHUB_TOKEN>}` for a GitHub ref. It never
      returns the other provider's token, and returns `null` when that provider's secret is unset
      (AC-12/13).
    - `pnpm typecheck` passes.

### Phase 4: Server slices *(T5 ∥ T13 ∥ T11; T5/T13 after T4; T11 after T2, T3, T6)*

- **T5: Repo identity: parse, dedupe, add, refresh, clone job**
  - **Action:**
    - **First**, commit GitHub characterization tests for `parseRepoUrl` (Rec-1).
    - Then add `parseRepoUrlHost(url) → { provider, host, owner, name, fullName }`:
      - Reject the raw input if it contains `%`, `\`, `/./`, `/../` or whitespace, *before*
        `new URL` (AC-10).
      - SSH `git@gitlab.com:<path>(.git)` anchored regex. GitHub SSH is unchanged.
      - `https:` only, no port, no userinfo, host lower-cased and exactly `github.com` |
        `gitlab.com`. Anything else → `AppError('unsupported_repo_host', 'Only github.com and
        gitlab.com repositories are supported', 400)` (AC-9).
      - GitHub → delegate to the **unchanged** `parseRepoUrl` (AC-11).
      - GitLab: strip query/fragment, everything from `/-/`, `.git` and the trailing `/`. Require
        2–21 segments, each matching `^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$` with no `..`
        and no consecutive `.`/`-` (AC-7/8/10).
    - `RepoService.add`:
      - GitLab: `container.gitlab().getProject(path)` → canonical `path_with_namespace` (AC-52) and
        `default_branch`. `findByIdentity` (case-insensitive for GitLab) → existing duplicate
        (AC-16). Then insert provider/host, and enqueue clone with
        `{repoId, owner, name, provider, host, url}`.
    - `runCloneJob`: **no token handling at all** (Q8). Pass the tokenless
      `cloneRemoteUrl(provider, fullName)` to `git.clone`, since the adapter adds credentials.
      Delete the `withGitHubToken` call and the `GITHUB_TOKEN_SECRET` read. Remove
      `withGitHubToken` / `GIT_TOKEN_USERNAME` / `GITHUB_HTTPS_HOST` from `repos/helpers.ts` /
      `constants.ts` once `grep` shows no remaining callers. Map a GitLab auth failure to the
      "connect a GitLab token in Settings" message, and redact (AC-12/13).
    - `refresh`: the URL comes from `cloneRemoteUrl(provider, fullName)` (AC-17). A missing payload
      provider means `github`.
    - `toRepoDto` returns `RepoWithHost` (`web_url` derived, sync fields, and
      `opts.syncRunning?:boolean` → `sync_state`) (AC-36).
    - `RepoRepository.list` orders by `created_at`.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, fastify-best-practices, drizzle-orm-patterns, zod, security
  - **Owned paths:** `server/src/modules/repos/helpers.ts`, `server/src/modules/repos/constants.ts`, `server/src/modules/repos/service.ts`, `server/src/modules/repos/repository.ts`, `server/src/modules/repos/routes.ts`, `server/test/repo-url-parse.test.ts`, `server/test/repos-gitlab.it.test.ts`
  - **Depends-on:** T1, T2, T4
  - **Risk:** high (SSRF / path-traversal surface)
  - **Known gotchas:**
    - The WHATWG URL parser normalizes `%2e%2e` and `..` out of the path silently, so traversal
      must be rejected on the **raw string** before `new URL` (AC-10:
      `gitlab.com/a/%2e%2e/b`).
    - The existing `repos/service.ts → repo-intel/constants.ts` import is the single allowed
      cross-module import. Don't add another.
    - The service still takes `Container` (known backlog). Don't widen that.
  - **Acceptance:** `pnpm vitest run test/repo-url-parse.test.ts test/repos-gitlab.it.test.ts`:
    - All GitHub characterization cases pass unchanged (AC-11).
    - Five crm-frontend forms (+ `?ref=main`, `#readme`) → the same `fullName` (AC-8).
    - `a/b/c/d/e` → owner `a/b/c/d`, name `e`. A 22-segment path → 400 (AC-7).
    - `https://gitlab.example.com/a/b`, `www.gitlab.com`, `https://1.2.3.4/a/b`, `:8443`,
      `user@`, `http:` → 400 `unsupported_repo_host`, with the `MockGitLabClient.calls` count at 0
      (AC-9).
    - `a/../b`, `a/%2e%2e/b`, `a/b;rm` → 400 (AC-10).
    - Add of a mixed-case URL → `full_name` equals the mock `path_with_namespace`, and a re-add of
      a differently-cased URL returns 200 with the existing repo (AC-16/52).
    - `github.com/acme/web` + `gitlab.com/acme/web` → 2 rows, 2 distinct `MockGitClient` clone
      paths (AC-15).
    - DTO has `provider:'gitlab'`, `host:'gitlab.com'`,
      `web_url:'https://gitlab.com/space-profit/platform/crm-frontend'` (AC-6/36).
    - Private project without a token → 400 `gitlab_token_missing`, and the `MockSecrets` access
      log has no `GITHUB_TOKEN` read (AC-13). With a token → 404 `gitlab_project_inaccessible`
      (AC-14).
    - GitLab refresh enqueues a `https://gitlab.com/...` URL (AC-17). GitHub refresh enqueues the
      same URL as before and the clone path is unchanged (AC-47).
    - Every clone payload URL and every `MockGitClient.cloned[].url` has no userinfo and no token
      substring, for both providers (Q8). `grep -rn "withGitHubToken" server/src` → no matches.
    - The existing `test/integration.it.test.ts` "POST /repos" case passes unmodified.

- **T13: Settings: GitLab token status + connection test**
  - **Action:**
    - `constants.ts`: `SECRET_KEY_BY_PROVIDER: Record<ConnTestProviderHost, SecretKey>` adds
      `gitlab:'GITLAB_TOKEN'`.
    - `routes.ts`:
      - Body schema `ConnTestRequestHost`, response `ConnTestResultHost`.
      - `secrets-status` returns `SecretsStatusHost` (AC-1).
      - The `gitlab` branch calls `(await container.gitlab()).checkToken()` and maps the result:
        `Connected as @<user>`, or `ok:false` naming invalid/expired/revoked, or
        `ok:false Missing scopes: read_api, read_repository`, or `ok:true … (scope sufficiency is
        verified on first repo access)`.
      - The catch path passes `err.message` through `redactSecret(…, key)`.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** fastify-best-practices, zod, security, onion-architecture
  - **Owned paths:** `server/src/modules/settings/routes.ts`, `server/src/modules/settings/constants.ts`, `server/test/settings-gitlab.test.ts`
  - **Depends-on:** T1, T3, T4
  - **Risk:** low
  - **Known gotchas:**
    - The rate limit config on `test-connection` must be kept.
    - `invalidateSecretCaches()` must run after `secrets.set`, so the new GitLab token is used
      (T4 clears `_gitlab`).
  - **Acceptance:** `pnpm vitest run test/settings-gitlab.test.ts` (inject with `MockGitLabClient` + in-memory secrets):
    - Saving a GitLab key leaves `secrets-status.github` unchanged, and vice versa. A second save
      replaces the first (AC-1).
    - The four `checkToken` outcomes → the messages above (AC-2–5).
    - The response body never contains the submitted key (AC-3).
    - Existing GitHub/LLM test-connection behaviour is unchanged (`test/routes-smoke.test.ts`
      passes).

- **T11: Review diff for GitLab: MR head ref, exclusions, empty-diff outcome**
  - **Action:**
    - `diff-loader.ts`: build the ref via `hostRepoRef(repoRow)`.
      - GitLab: `await git.fetchPullHead(ref, pull.number)` (best-effort), then
        `git.diff(ref, 'origin/<base>', pull.headSha)` (AC-29/30).
      - GitHub path unchanged.
      - Return `{ diff, source: 'local'|'fallback', excludedFiles }`. In the fallback,
        `excludedFiles` counts the `pr_files` rows with `patch_omitted` (AC-31). That is a new
        return type, so adapt the sole caller.
    - `run-executor.ts`:
      - Log ``runLog.warn(`${n} files not reviewed (diff unavailable)`)`` when `excludedFiles > 0`
        (it ends up in the persisted trace).
      - If `diff.files.length === 0`, complete every queued run as failed with error
        `no_reviewable_diff: No reviewable diff` and **no** engine/LLM call (AC-32, Q5).
      - Spec-doc reads use `hostRepoRef(repo)`.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, typescript-expert
  - **Owned paths:** `server/src/modules/reviews/diff-loader.ts`, `server/src/modules/reviews/run-executor.ts`, `server/test/diff-loader-gitlab.test.ts`, `server/test/run-executor-no-diff.test.ts`
  - **Depends-on:** T1, T2, T3, T6
  - **Risk:** medium
  - **Known gotchas:**
    - The grounding gate and deterministic re-score live in reviewer-core. **Do not** add any
      filtering there or bypass it.
    - The deleted-file guarantee (AC-33) already holds, because deleted files contribute no
      `newLineNumbers`. Assert it, don't re-implement it.
    - `run-executor.ts` types params as `typeof schema.repos.$inferSelect` (known violation). Don't
      add more.
  - **Acceptance:** `pnpm vitest run test/diff-loader-gitlab.test.ts test/run-executor-no-diff.test.ts`:
    - A GitLab pull calls `MockGitClient.fetchPullHead` with `provider:'gitlab'`, and the diff
      source is `local` when the mock git returns files (AC-29/30).
    - Forced fallback with 2 `too_large` files → `excludedFiles=2`, and the trace log contains
      "2 files not reviewed (diff unavailable)" (AC-31).
    - All files omitted → a run with status failed, error starting `no_reviewable_diff`, and the
      stub LLM call count = 0 (AC-32).
    - A finding on a deleted file's line is dropped by grounding (AC-33).
    - Existing `test/reviews.it.test.ts` and `test/run-executor-project-context.test.ts` pass.

### Phase 5: Routes *(T9 → T12 → T10, serial; T9 after T4, T5, T8)*

- **T9: Sync-on-open list routes, manual sync, SSE completion, polling via coordinator**
  - **Action:**
    - `config.ts`: `PR_SYNC_TTL_SECONDS` (default 60) → `prSyncTtlMs` (also the back-off).
    - Container `get prSync`: a singleton `PrSyncCoordinator` over `PrListSyncService({ hosts:
      p => this.prHost(p), store: this.pullRequestRepo, statusRepo })`.
      `ContainerOverrides.prSyncClock`.
    - `pulls/routes.ts`:
      - Extract the persisted-list + rollup code into a local `readPersistedList()` with no
        behaviour change. It maps `is_draft` / `stats_known` **only when non-null** so the GitHub
        DTO stays field-identical (AC-60).
      - `GET /repos/:id/pulls`: `coordinator.onOpen(repo)` (never awaited), then return
        `readPersistedList()` (AC-55). **Delete** the inline GitHub sync and the 10-PR backfill
        (moved to T8).
      - `GET /repos/:id/pulls/page` → `{ pulls, sync: { trigger, ...snapshot } }`.
      - `POST /repos/:id/pulls/sync` → `{ trigger }` (AC-58).
      - `GET /repos/:id/pulls/sync/events` → SSE. If not running, emit one `done` snapshot and end.
        Otherwise emit `done` on completion and end. Clean up the listener on `req.raw` close, but
        **do not** cancel the sync (AC-64).
    - `polling/routes.ts`: `coordinator.manual(repo)` + `awaitRunning`. Keep the response shape
      `{ synced, reviewTriggered:false }`.
    - `repos/service.ts`: `list()` passes `syncRunning: container.prSync.isRunning(id)`.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** fastify-best-practices, onion-architecture, zod, typescript-expert
  - **Owned paths:** `server/src/modules/pulls/routes.ts`, `server/src/modules/polling/routes.ts`, `server/src/platform/container.ts`, `server/src/platform/config.ts`, `server/src/modules/repos/service.ts`, `server/test/pulls-sync-on-open.it.test.ts`, `server/test/pulls-list-perf.it.test.ts`
  - **Depends-on:** T4, T5, T8
  - **Risk:** high (behaviour change for every GitHub user)
  - **Known gotchas:**
    - `test/integration.it.test.ts:112-128` and `test/brief.it.test.ts:474` call `GET
      /repos/:id/pulls` and must keep passing. They rely on seeded rows, so a detached sync is fine.
      If one asserts freshly-synced data, adjust *only* that read-from-persisted expectation (AC-48
      allows exactly this).
    - The SSE pattern for headers and flush is in `modules/reviews/routes.ts` (`/runs/:id/events`).
    - Don't route the sync through `JobRunner`: its retries/timeouts and persisted jobs rows
      conflict with the single-flight semantics.
  - **Acceptance:** `pnpm vitest run test/pulls-sync-on-open.it.test.ts test/pulls-list-perf.it.test.ts`:
    - With the GitHub mock `listPullRequests` never resolving, `GET /repos/:id/pulls` returns the
      persisted rows (AC-55).
    - Open at fake t+61 s → `sync.trigger:'started'`, 1 host list call (AC-56). Second open at
      +30 s → `fresh`, 0 host calls (AC-61).
    - Host 500 ×10 opens → 1 attempt, `sync.state:'failed'`, `last_synced_at` unchanged (AC-25/62).
    - Manual sync during a run → `joined`. 5 manual calls → 1 host call (AC-57/58).
    - SSE emits exactly one `done` and ends.
    - Closing the SSE connection mid-sync still persists `last_synced_at` (AC-64).
    - A GitHub PR DTO snapshot equals the pre-change field set (no `is_draft`/`stats_known` keys)
      (AC-60).
    - GitHub token missing → the GitLab repo still syncs (AC-27).
    - `POST /repos/:id/poll` still returns `reviewTriggered:false`.
    - Perf: 1 000 seeded PRs, 20 reads → p95 ≤ 300 ms with a sync running (NFR).
    - Existing `test/integration.it.test.ts`, `test/pull-request-repository.it.test.ts` and
      `test/routes-smoke.test.ts` pass.

- **T12: Provider-aware PR detail + read-only comments**
  - **Action:**
    - `pulls/detail-service.ts`: `PullDetailService({ hosts, store })`.
      - `refresh(pr, repo)`: GitLab → `getPullRequestDetail(ref, n, { unlessHeadSha:
        pr.detailHeadSha })`. `unchanged` → update meta only and serve the persisted files/commits.
        `full` → `store.replaceDetail(tx)` (files incl. `previous_path` / `change_type` /
        `patch_omitted`, commits, body, stats, `stats_known=true`, `is_draft`, `detail_head_sha`).
      - GitHub → today's always-full path, moved verbatim.
      - Host failure → persisted detail (AC-26).
      - Returns `PrDetailHost` including `files_omitted_by_host` (AC-21/24/51/54).
      - `assertWritable(repo)` → `AppError('provider_read_only', 'Posting to GitLab is not
        supported yet.', 400)` for GitLab.
    - `routes.ts`: `GET /pulls/:id` → service. `GET /pulls/:id/comments` returns `[]` for GitLab
      **before** resolving any client (AC-45). `POST /pulls/:id/comments` calls `assertWritable`
      first (AC-44).
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** fastify-best-practices, onion-architecture, drizzle-orm-patterns, zod
  - **Owned paths:** `server/src/modules/pulls/routes.ts`, `server/src/modules/pulls/detail-service.ts`, `server/test/pulls-detail-gitlab.it.test.ts`, `server/test/pulls-comments-gitlab.it.test.ts`
  - **Depends-on:** T8, T9
  - **Risk:** medium
  - **Known gotchas:**
    - Keep files/commits replace-in-place inside **one** transaction (the existing comment in
      `pulls/routes.ts:234-241` explains why).
    - The GitHub detail behaviour must be byte-identical (AC-48, Q6).
    - `pulls-comments.it.test.ts` must pass unmodified.
  - **Acceptance:** `pnpm vitest run test/pulls-detail-gitlab.it.test.ts test/pulls-comments-gitlab.it.test.ts`:
    - First GitLab detail open → files (renamed with `previous_path`, `too_large` without a patch)
      and commits are persisted, and `files_omitted_by_host:1` (AC-21/24/33).
    - Second open with the same head → 0 `/diffs` and `/commits` calls on `MockGitLabClient`
      (NFR).
    - Head moved → a refetch.
    - A stats-unknown PR → known stats after the open (AC-54).
    - Draft → `is_draft:true` (AC-51).
    - Host offline → persisted detail with 200 (AC-26).
    - POST comment on a GitLab PR → 400 `provider_read_only`, and `MockGitLabClient.calls` /
      `MockGitHubClient.createdComments` are both empty (AC-44).
    - GET comments → 200 `[]` (AC-45).
    - `test/pulls-comments.it.test.ts` passes unmodified (AC-48).

- **T10: Linked issue for Intent & PR Brief via the PR host**
  - **Action:**
    - `IntentDeriverDeps` and `BriefService` deps: replace `github: () => Promise<GitHubClient>`
      with `prHost: (p: RepoProvider) => Promise<PullRequestHost>`.
    - Issue number = `extractIssueRef(body) ?? await host.getLinkedIssueNumber(ref, pull.number)`.
      The GitHub host returns null, so GitHub behaviour is unchanged.
    - `getIssue(ref, n)`. Any failure (incl. confidential/404) → the source is unavailable /
      missing input, as today (AC-23).
    - `git.readFile` refs via `hostRepoRef`.
    - Update the two container getters (`intent`, `briefService`) to pass `prHost`.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, typescript-expert, security
  - **Owned paths:** `server/src/modules/reviews/intent-deriver.ts`, `server/src/modules/brief/service.ts`, `server/src/platform/container.ts`, `server/test/intent-gitlab-issue.test.ts`, `server/test/brief-gitlab-issue.test.ts`
  - **Depends-on:** T4, T9, T12
  - **Risk:** medium
  - **Known gotchas:**
    - Untrusted issue/MR text must still be wrapped by reviewer-core's `wrapUntrusted`. Never wrap
      it here and never bypass it.
    - `test/intent-deriver.test.ts` and `test/brief*.test.ts` build deps with a `github` fake, so
      update those fakes to the `prHost` shape. That is a mechanical fixture change only;
      assertions stay unchanged.
  - **Acceptance:** `pnpm vitest run test/intent-gitlab-issue.test.ts test/brief-gitlab-issue.test.ts test/intent-deriver.test.ts test/brief-helpers.test.ts`:
    - A GitLab MR whose body says "Closes #12" → the intent prompt input includes issue 12's
      title/body.
    - The relation-only case (`getLinkedIssueNumber` → 12, empty body) works too.
    - Issue fetch throwing → `linked_issue` status `unavailable`, with no error (AC-23).
    - GitHub assertions are unchanged.

### Phase 6: Client UI *(T18 ∥ T19 ∥ T20; all after T17)*

- **T18: PR list: draft badge, unknown stats, sync status, refresh**
  - **Action:**
    - `page.tsx`: use `usePullsPage`. Call `usePrSyncCompletion(repoId, trigger ∈
      {started,joined} || manualPending)`.
    - New `_components/SyncStatus/`:
      - "Updating…" while running, using `aria-live="polite"` (AC-59).
      - "Synced {relative}" / "Never synced" at all times.
      - Failed → "Showing data from {time}" notice; the list stays visible (AC-25).
    - `FilterBar` `onRefresh` → `useSyncPulls` + the existing `useRefreshRepo` (Q4). Joined →
      subscribe as well (AC-58).
    - `PRRow`: a "Draft" `Badge` when `pr.is_draft` (AC-50). Size/± cell shows "—" when
      `stats_known === false` (AC-54).
    - `helpers.sizeOf` handles unknown stats.
    - New keys go in `messages/en/prReview.json` (`list.sync.*`, `list.draft`,
      `list.statsUnknown`).
  - **Module:** client
  - **Type:** ui
  - **Skills to use:** react-best-practices, next-best-practices, frontend-ui-architecture, react-testing-library
  - **Owned paths:** `client/src/app/repos/[repoId]/pulls/page.tsx`, `client/src/app/repos/[repoId]/pulls/constants.ts`, `client/src/app/repos/[repoId]/pulls/helpers.ts`, `client/src/app/repos/[repoId]/pulls/styles.ts`, `client/src/app/repos/[repoId]/pulls/_components/PRRow/**`, `client/src/app/repos/[repoId]/pulls/_components/FilterBar/**`, `client/src/app/repos/[repoId]/pulls/_components/SyncStatus/**`, `client/messages/en/prReview.json`
  - **Depends-on:** T17
  - **Risk:** medium
  - **Known gotchas:**
    - `GRID` + `COLUMN_KEYS` drive both header and rows (`client/INSIGHTS.md`). Don't add a column;
      the badge goes in the title cell.
    - Inline `styles.ts` + CSS tokens, not Tailwind.
    - The table wrapper has `overflow:hidden`, so a tooltip needs `position:fixed`.
    - No hard-coded strings.
  - **Acceptance:** `cd client && pnpm test -- src/app/repos/\[repoId\]/pulls` passes:
    - PRRow with `is_draft` shows "Draft". `stats_known:false` shows "—", not "0".
    - SyncStatus with `running` shows "Updating…". `failed` shows "Showing data from …". After a
      mocked `done`, the rows update with no navigation (AC-59).
    - Refresh click → 1 `POST …/pulls/sync`.
    - `pnpm typecheck` passes.

- **T19: PR detail: host links, draft, read-only commenting, rename & omitted files**
  - **Action:**
    - `[number]/page.tsx`: the repo comes from `useRepos`. Build all links with `host-urls`
      (header, `goToFile`, FindingsTab, OverviewTab/BlastCard) (AC-36/37/38). Pass
      `readOnly = repo.provider === 'gitlab'`.
    - `PrDetailHeader`: rename `githubUrl` → `hostUrl`. The label is
      `t('prHost.viewOn', {provider})` ("View on GitLab" / "View on GitHub"), and the reference is
      `#<number>` (AC-39). Show a "Draft" badge when `pr.is_draft` (AC-51).
    - `DiffTab` + `components/diff-viewer`: when `readOnly`, render a **disabled** Comment/Post
      button whose `aria-describedby` points at a visible inline note "Posting comments to GitLab
      isn't supported yet — copy the text instead." (keyboard-reachable, not hover-only) (AC-43).
    - `FindingCard`: a "Copy finding" button (clipboard) for read-only repos.
    - `FileCard`: rename shows `old → new` (AC-33). `patch_omitted` shows "Diff too large on
      GitLab" with no patch (AC-24).
    - `DiffTab`: when `files_omitted_by_host > 0`, show "{n} files not reviewed (diff unavailable)"
      (AC-31 UI).
    - All new strings go in the new namespace `messages/en/prHost.json`. The hard-coded "View on
      GitHub" and the toast "Couldn't post the comment to GitHub." in these components move to i18n
      (AC-40).
  - **Module:** client
  - **Type:** ui
  - **Skills to use:** react-best-practices, next-best-practices, frontend-ui-architecture, react-testing-library, security
  - **Owned paths:** `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`, `client/src/app/repos/[repoId]/pulls/[number]/_components/PrDetailHeader/**`, `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/**`, `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/**`, `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/**`, `client/src/app/repos/[repoId]/pulls/[number]/_components/DiffTab/**`, `client/src/components/diff-viewer/**`, `client/messages/en/prHost.json`
  - **Depends-on:** T17
  - **Risk:** medium
  - **Known gotchas:**
    - Do not edit `messages/en/prReview.json` (owned by T18). Use `prHost`.
    - Render untrusted MR text as text only. Links must go through `host-urls`.
    - Nested dialogs: if a copy confirmation modal is added, the Escape handling is a known trap
      (`client/INSIGHTS.md`). Prefer a toast.
    - Existing `DiffTab.test.tsx` must pass unmodified for GitHub.
  - **Acceptance:** `cd client && pnpm test -- src/app/repos/\[repoId\]/pulls/\[number\] src/components/diff-viewer` passes:
    - A GitLab fixture header shows "#5", "View on GitLab", href
      `…/crm-frontend/-/merge_requests/5`, and "Draft".
    - A finding file link is `…/-/blob/<sha>/<path>#L10-20`.
    - The read-only DiffTab shows a disabled post button with an `aria-describedby` note, and copy
      calls `navigator.clipboard.writeText` with the finding text.
    - A renamed file shows `old → new`. An omitted file shows the too-large note.
    - GitHub fixtures render the same hrefs as today.
    - `grep -rniE "merge request|\\bMR\\b|![0-9]" client/messages/en client/src/app/repos` → no
      matches (AC-39).

- **T20: Add repository copy, Settings GitLab token, Conventions host links**
  - **Action:**
    - `AddRepoView`: move the hard-coded copy to the new `messages/en/repos.json`. The
      label/hint/placeholder mention github.com **and** gitlab.com with examples
      `https://github.com/acme/payments-api` and
      `https://gitlab.com/space-profit/platform/crm-frontend`. Surface the server error message
      (`unsupported_repo_host`, `gitlab_token_missing`, `gitlab_project_inaccessible`) inline
      (AC-41).
    - `SettingsApiKeys/constants.ts`: add a `gitlab` row ("GitLab access token"). The hint lists
      `read_api` + `read_repository` (AC-53). The status pill uses `SecretsStatusHost.gitlab`
      (AC-1). Strings go in `messages/en/settings.json`.
    - `ConventionsView/helpers.ts`: `evidenceHostUrl(repo, c)` via `host-urls`, using
      `/-/blob/<default_branch>/…` for GitLab. `SnippetBlock`/`ConventionCard` take a label prop:
      "View on GitLab/GitHub" (`messages/en/conventions.json`).
  - **Module:** client
  - **Type:** ui
  - **Skills to use:** react-best-practices, frontend-ui-architecture, react-testing-library, next-best-practices
  - **Owned paths:** `client/src/app/onboarding/_components/AddRepoView/**`, `client/src/app/settings/[section]/_components/SettingsView/_components/SettingsApiKeys/**`, `client/src/app/conventions/_components/ConventionsView/helpers.ts`, `client/src/app/conventions/_components/ConventionsView/helpers.test.ts`, `client/src/app/conventions/_components/ConventionsView/_components/SnippetBlock/**`, `client/src/app/conventions/_components/ConventionsView/_components/ConventionCard/**`, `client/messages/en/repos.json`, `client/messages/en/settings.json`, `client/messages/en/conventions.json`
  - **Depends-on:** T17
  - **Risk:** low
  - **Known gotchas:**
    - The global query error policy is toast on 5xx only, while 4xx stays silent. The add-repo 400
      must therefore be rendered inline by the view.
    - Keep `evidenceGitHubUrl` output identical for GitHub (rename only if all call sites move).
  - **Acceptance:** `cd client && pnpm test -- src/app/onboarding src/app/settings src/app/conventions` passes:
    - Add repo shows both host examples, and a mocked 400 `unsupported_repo_host` message is
      visible.
    - Settings shows a GitLab row whose hint contains `read_api` and `read_repository`.
    - Conventions evidence href for a GitLab repo is `https://gitlab.com/…/-/blob/main/<path>#L3-L5`
      formatted per AC-37 (`#L3-5`). The GitHub href is unchanged.
    - `pnpm typecheck` passes.

### Phase 7: Cross-cutting verification *(T23 ∥ T21, then T22)*

- **T23: GitLab feature-parity integration test**
  - **Action:** One it-test file uses the T16 fixture (`SEED_GITLAB_FIXTURE=1` seed in
    `beforeAll`), `MockGitLabClient`, `MockGitClient` and a stub LLM. Against GitLab PR #5 it
    exercises:
    - `POST /pulls/:id/review` (trace has the same step names as the GitHub run, and grounding is
      applied);
    - `GET/POST` intent;
    - `POST /pulls/:id/brief`;
    - `GET /pulls/:id/smart-diff` (`.gitlab-ci.yml` → wiring);
    - `GET /pulls/:id/blast`;
    - eval-case creation from a finding.
  - **Module:** server
  - **Type:** backend
  - **Skills to use:** onion-architecture, fastify-best-practices
  - **Owned paths:** `server/test/gitlab-feature-parity.it.test.ts`
  - **Depends-on:** T10, T11, T12, T14, T16
  - **Risk:** medium
  - **Known gotchas:** Use unique full_names if the test inserts extra repos (`server/INSIGHTS.md`).
  - **Acceptance:** `pnpm vitest run test/gitlab-feature-parity.it.test.ts` passes, with all six
    features returning 2xx and contract-valid bodies (AC-29, AC-34).

- **T21: e2e flows for GitLab + hermetic env**
  - **Action:**
    - `scripts/e2e.sh`: export `SEED_GITLAB_FIXTURE=1` and `DEVDIGEST_HOSTS_OFFLINE=true` before
      seed and boot.
    - `09-gitlab-pr-list.flow.json`: open the app, select repo text
      `space-profit/platform/crm-frontend`, then wait for the texts `#5`, `Draft`, `—` and
      `Showing data from` / `Synced`.
    - `10-gitlab-pr-detail.flow.json`: click PR #5, `wait --url /pulls/5` (AC-49), then text
      `View on GitLab`, `Draft`, the read-only note, `Diff too large on GitLab`, and the rename
      arrow. Use `get attr` on the external link to assert it includes `/-/merge_requests/5`
      (AC-37).
    - Extend `07-settings` or add `11-settings-gitlab.flow.json` asserting `read_api` +
      `read_repository`.
    - Update the `e2e/README.md` coverage table.
  - **Module:** e2e
  - **Type:** e2e
  - **Skills to use:** typescript-expert (flows are JSON). Consult `e2e/README.md` and `e2e/docs/flows.md`.
  - **Owned paths:** `scripts/e2e.sh`, `e2e/specs/09-gitlab-pr-list.flow.json`, `e2e/specs/10-gitlab-pr-detail.flow.json`, `e2e/specs/11-settings-gitlab.flow.json`, `e2e/README.md`
  - **Depends-on:** T9, T12, T16, T18, T19, T20
  - **Risk:** medium
  - **Known gotchas:**
    - Flows 02/04/05 follow the home redirect to the *first* repo. T5 orders repos by
      `created_at`, and T16 inserts GitLab after GitHub. Verify both stay green.
    - Never `docker compose down -v`.
    - Deterministic locators only.
  - **Acceptance:** `./scripts/e2e.sh` exits 0 with all flows 01–11 passing, and no outbound
    request to gitlab.com (`DEVDIGEST_HOSTS_OFFLINE`).

- **T22: Verification gate (no new code)**
  - **Action:** Run the full matrix and fix nothing outside the owning task. Report failures back
    to the owning task.
  - **Module:** server, client, mcp, e2e
  - **Type:** backend
  - **Skills to use:** onion-architecture, security
  - **Owned paths:** none
  - **Depends-on:** T7, T13, T15, T21, T23
  - **Risk:** low
  - **Known gotchas:** `pnpm arch` needs Node 22 (`PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"`).
    Record the warning count on `main` before comparing.
  - **Acceptance:** all of the following pass.
    - `cd server && pnpm typecheck && pnpm test`.
    - `cd server && pnpm arch` → **0 errors**, warnings ≤ the `main` baseline.
    - `cd client && pnpm typecheck && pnpm test`.
    - `cd reviewer-core && pnpm typecheck && pnpm test`, with `git diff --stat main -- reviewer-core`
      empty.
    - `cd mcp && pnpm typecheck && pnpm test`.
    - `node scripts/check-shared-sync.mjs`.
    - `./scripts/e2e.sh`.
    - `git diff main -- server/src/db/migrations/00{00..18}*` empty.
    - `grep -rn "github.com" client/src/app` → only via `lib/github-urls.ts` / `host-urls.ts`
      (AC-36).
    - `grep -rn "refetchInterval" client/src/lib/hooks/core.ts` → none for pulls (AC-63).

## Testing strategy

- **server, hermetic** (`cd server && pnpm vitest run <file>`): `contracts-repo-host`, `repo-ref`,
  `smart-diff-gitlab`, `gitlab-http`, `gitlab-client`, `simple-git-host-paths` (temp dir),
  `host-ref-threading`, `pr-sync-coordinator`, `pr-sync-service`, `container-hosts`,
  `repo-url-parse`, `settings-gitlab`, `diff-loader-gitlab`, `run-executor-no-diff`,
  `intent-gitlab-issue`, `brief-gitlab-issue`. Fakes come from `adapters/mocks.ts` +
  `ContainerOverrides`, with no network, keys or Docker.
- **server, Postgres** (`*.it.test.ts`, testcontainers, Docker required): `repo-host-migration`,
  `pr-sync-repository` (per-page ≤ 200 ms), `seed-gitlab`, `repos-gitlab`, `pulls-sync-on-open`,
  `pulls-list-perf` (p95 ≤ 300 ms @ 1 000 PRs), `pulls-detail-gitlab`, `pulls-comments-gitlab`,
  `gitlab-feature-parity`. Full suite: `cd server && pnpm test`.
- **Security checks carried by tests:**
  - Host allowlist + no-network on reject: T5.
  - Raw-string traversal rejection: T5.
  - Clone-root containment: T6.
  - Token never in messages / git errors / connection-test output: T3, T6, T13.
  - No GitHub token for GitLab: T4, T5.
  - Cross-host redirect = error: T3.
  - Links restricted to `https:` on the repo host: T17.
- **Architecture:** `cd server && pnpm arch` (Node 22), 0 errors.
- **Contracts:** `node scripts/check-shared-sync.mjs`.
- **client** (`cd client && pnpm test -- <path>`, vitest + jsdom + RTL, fetch mocked; `pnpm
  typecheck`): `host-urls`, `pr-sync` (fake timers), `core.pulls`, PRRow/SyncStatus/FilterBar,
  PrDetailHeader/DiffTab/FindingCard/FileCard, AddRepoView/SettingsApiKeys/Conventions helpers.
- **mcp:** `cd mcp && pnpm typecheck && pnpm test`.
- **reviewer-core:** `cd reviewer-core && pnpm typecheck && pnpm test`, unchanged (must stay green
  with zero diff).
- **e2e:** `./scripts/e2e.sh` (hermetic :5433/:3101/:3100, seeded with `SEED_GITLAB_FIXTURE=1`,
  `DEVDIGEST_HOSTS_OFFLINE=true`). Flows 01–08 cover no-regression; 09–11 cover the GitLab list,
  detail and settings.

## Risks & mitigations

- **GitHub users lose "list always fresh on GET" semantics.** → TTL 60 s + the SSE refetch. T9's
  AC-60 snapshot test and the existing integration tests guard it. The deploy can raise or lower
  `PR_SYNC_TTL_SECONDS`.
- **Single-flight is per process.** A multi-instance server could double-sync. → Documented
  (Rec-2), out of scope until the multi-user spec, which should use a PG advisory lock.
- **The GitLab GraphQL `diffStatsSummary` shape differs from the spec's verification.** → T3 keeps
  the query in one file with recorded fixtures. A null or missing field degrades to
  `stats_known:false` ("—"), never 0 (AC-54).
- **WHATWG URL normalization hides traversal.** → Raw-string rejection before `new URL` (T5), plus
  clone-root containment in the adapter (T6). These are two independent layers.
- **The token leaks via `.git/config`, the remote URL, argv or git stderr.** → Q8: credentials
  are passed only as a per-invocation, host-scoped `http.extraHeader` through `GIT_CONFIG_*` env
  (T6, wired in T4). They never go into the URL, argv or `git config`. Legacy userinfo remotes are
  rewritten tokenless on the next fetch. `GIT_TRACE*` / `GIT_CURL_VERBOSE` are stripped. Every
  surfaced error goes through `redactSecret`, covering the token and the base64 header (T1/T3/T6).
  T6 asserts `.git/config` is clean after clone + refresh.
- **Residual exposure of the env-var channel.** The header is readable from
  `/proc/<pid>/environ` by the same uid or root, for the lifetime of the git child. → Accepted:
  that is strictly narrower than argv (any user) or `.git/config` (on disk), and it needs no
  helper file (unlike `GIT_ASKPASS`).
- **An old git (< 2.31) ignores `GIT_CONFIG_COUNT`.** → T6 checks the version once and fails
  closed (an anonymous attempt, then an auth error with a clear message). There is no fallback to
  URL embedding.
- **The legacy-remote rewrite is a behaviour change for existing GitHub clones.** → It happens in
  place, with the same clone path (AC-47 holds), and is covered by T6's legacy-clone acceptance
  case.
- **Hot-file contention** (`container.ts`, `pulls/routes.ts`, `config.ts`, `repos/service.ts`). →
  Strict serial chains T4 → T9 → T10 and T5 → T9, and T9 → T12, encoded in `Depends-on`.
- **The SSE `EventSource` reconnect loop turns into polling.** → T17 closes on `done`/`error`, and
  a fake-timer test asserts 0 requests over 10 min.
- **e2e flows land on the wrong repo** once a second repo exists. → `created_at` ordering (T5),
  env-gated late insert (T16), and T21 re-runs flows 02/04/05.
- **Fixture churn from the `IntentDeriverDeps` / `BriefService` deps rename.** → T10 limits test
  edits to dependency fakes, with assertions unchanged.
- **Shallow clones lack the MR merge-base.** → The fetch at depth 50 makes it usually present.
  Otherwise the AC-31 fallback takes over (the spec accepts this).

## Requirement → task traceability (AC → tasks)

| AC | Tasks | AC | Tasks | AC | Tasks |
|---|---|---|---|---|---|
| AC-1 | T4, T13, T20 | AC-22 | T3 | AC-58 | T8, T9, T17, T18 |
| AC-2 | T3, T13 | AC-23 | T3, T10 | AC-59 | T17, T18 |
| AC-3 | T3, T13 | AC-24 | T3, T12, T19, T21 | AC-60 | T9, T18 |
| AC-4 | T3, T13 | AC-25 | T3, T8, T9, T18 | AC-61 | T8, T9 |
| AC-5 | T3, T13 | AC-26 | T9, T12 | AC-62 | T8, T9 |
| AC-6 | T5 | AC-27 | T4, T8, T9 | AC-63 | T17, T18, T22 |
| AC-7 | T5 | AC-28 | T3, T8 | AC-64 | T8, T9 |
| AC-8 | T5 | AC-29 | T11, T23 | | |
| AC-9 | T5 | AC-30 | T6, T11 | | |
| AC-10 | T5, T6 | AC-31 | T11, T19 | | |
| AC-11 | T5 | AC-32 | T11 | | |
| AC-12 | T4, T5, T6, T7 | AC-33 | T3, T11, T12, T19 | | |
| AC-13 | T3, T4, T5 | AC-34 | T10, T14, T23 | | |
| AC-14 | T3, T5, T8 | AC-35 | T14, T23 | | |
| AC-15 | T2, T3, T5, T6 | AC-36 | T5, T17, T19, T22 | | |
| AC-16 | T2, T5 | AC-37 | T17, T19, T20, T21 | | |
| AC-17 | T5, T6 | AC-38 | T17, T19, T20 | | |
| AC-18 | T3, T8 | AC-39 | T19, T21, T22 | | |
| AC-19 | T3, T9 | AC-40 | T18, T19, T20 | | |
| AC-20 | T3 | AC-41 | T20 | | |
| AC-21 | T3, T12, T19 | AC-42 | T15 | | |
| AC-50 | T3, T8, T16, T18, T21 | AC-43 | T19, T21 | | |
| AC-51 | T12, T19, T21 | AC-44 | T12 | | |
| AC-52 | T5 | AC-45 | T12 | | |
| AC-53 | T20, T21 | AC-46 | T2 | | |
| AC-54 | T3, T8, T12, T18 | AC-47 | T5, T6 | | |
| AC-55 | T8, T9, T18 | AC-48 | T4, T8, T9, T12, T22 | | |
| AC-56 | T8, T9 | AC-49 | T19, T21 | | |
| AC-57 | T8, T9, T17 | | | | |

NFR mapping:
- Security allowlist / redirect: T3, T5.
- Path safety: T5, T6.
- Secrets redaction: T1, T3, T6, T13.
- List-read p95: T9.
- Per-page p95 + ≤ 1 concurrent request: T8.
- Retry policy: T3.
- TTL deploy config: T9.
- Changed-head-only detail refetch: T12.
- Accessibility of the disabled post control: T19.
- `pnpm arch` / no regression: T22.

## Red-flags check

- [x] Every requirement maps to a task (64/64 ACs in the table above, plus NFRs).
- [x] No specification was authored or edited. `specs/2026-10-16-gitlab-merge-requests.md` was
      taken as input, and its gaps are recorded as Q1–Q9, all resolved by user decision on
      2026-10-16 (Q8 changed).
- [x] Execution mode is recorded (multi-agent) and the plan is shaped for it (phases, DAG,
      concurrency notes).
- [x] Dependencies form a DAG. Hot-file chains are T4 → T9 → T12 → T10 and T5 → T9, and T6
      now precedes T4 (the credential-resolver constructor option). There are no cycles.
- [x] (multi-agent) Concurrent tasks have non-overlapping Owned paths. `container.ts` (T4, T9,
      T10), `config.ts` (T4, T9), `pulls/routes.ts` (T9, T12) and `repos/service.ts` (T5, T9) are
      only touched by tasks on one serial chain. T18/T19/T20 use disjoint i18n files (`prReview`,
      `prHost`, `repos`/`settings`/`conventions`).
- [x] Every Acceptance is a command plus a named test case or an observable result.
- [x] No edits to existing shared contracts. The only touch to an existing shared file is the
      additive `export *` lines in both `index.ts` copies, called out under "Contracts".
