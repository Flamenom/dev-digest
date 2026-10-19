# Next steps after GitLab integration: handoff plan

**Written:** 2026-10-19 · **State of `main`:** `10ee600` (PR #10 merged)
**Audience:** a fresh agent session with no memory of the previous work. Read this file
first, then the files under "Read before starting" for the task you pick up.

This is a **backlog and handoff plan**. Only Tasks A and B are ready to implement as written.
Task C needs a spec first, and Task D needs a product decision first. The workflow for each task
is given under "How to execute".

---

## 1. Where the project stands

DevDigest is a local-first AI pull-request review studio. It is planned to become a **shared
server-hosted tool for a team**. Stack and map: root `CLAUDE.md` (auto-loaded), `README.md`,
`docs/architecture.md`.

### Done and merged

| PR | What |
|----|------|
| #6 | README rewrite. `scripts/check-shared-sync.mjs` and the `shared-sync.yml` CI guard keep the two vendored `@devdigest/shared` copies identical. PR-list upsert batched. |
| #7 | `PullRequestRepository` behind `container.pullRequestRepo`. |
| #8 / #9 | **GitLab MVP** (read-only), spec `specs/2026-10-16-gitlab-merge-requests.md` (64 ACs, approved), plan `docs/plans/gitlab-integration.md` (23 tasks). The evals proxy (LiteLLM master key) and the workflow eval cases were fixed. `CLAUDE.md` routing gaps were closed. |
| #10 | GitLab follow-ups: onion cleanup (no Drizzle in pulls/polling routes, `RepoService` deps object), migration `0020` (CHECKs, case-insensitive GitLab identity index, aborts rather than deleting on duplicates), typed `HostGitClient`/`HostCodeIndex` ports, shared read-only UI on the client, test hygiene. |

### Key product decisions already made for GitLab (do not re-ask)

- **Host:** gitlab.com only. Self-managed GitLab is **not planned**.
- **Repos and auth:**
  - Nested groups are supported.
  - A workspace can mix GitHub and GitLab repos; the provider is chosen **per repo**.
  - There is **one GitLab token per workspace**, which acts as a service account.
  - The UI suggests the minimal scopes `read_api` + `read_repository` and shows no write-scope warning.
- **UI:**
  - The wording is "Pull request" with `#number` **everywhere**, GitLab included. Only the external link names the provider ("View on GitLab").
  - Draft MRs are imported as normal PRs and get a Draft badge.
- **Data loading:**
  - The list stores metadata plus `+/−` stats from GraphQL `diffStatsSummary`. Diffs, patches and commits are loaded **only on the PR page**.
  - There are no caps on the number of MRs or files.
- **Sync model (all providers):** the list is **synced when it is opened**.
  - The list renders from the DB immediately, and the provider sync runs in parallel (stale-while-revalidate).
  - Single-flight per repo: at most one sync runs per repo **within one process**.
  - TTL is 60 s from the last success, with a 60 s back-off after a failure. Manual refresh bypasses the TTL.
  - Completion is signalled by one-shot SSE `done`.
  - **No periodic sync**, on the server or the client.
- **Git credentials:** passed per invocation through `GIT_CONFIG_*` `http.extraHeader`. They are **never** in clone URLs, argv or `.git/config`.
- **Commenting on GitLab is read-only:** a POST returns `provider_read_only`, and a GET returns `[]`.

---

## 2. Backlog (priority order)

### Task A: user documentation for GitLab (small · ready)

**Why:** `README.md` and the user's Ukrainian docs (Obsidian) predate GitLab support.

1. **`README.md`** (English, repo root):
   - Add a GitLab row and section to "Features": add a repo from gitlab.com, set the GitLab token in
     Settings → API Keys, sync-on-open behaviour (the list renders instantly, a sync runs on open with a 60 s
     TTL, the Refresh button), read-only comments for GitLab PRs, Draft badge.
   - Mention migration `0020` in troubleshooting. It aborts with a clear message if GitLab repos
     differ only by case; fix that by removing the newer duplicate.
   - The `doc-writer` agent may edit `README.md`.
2. **Obsidian notes** (Ukrainian), folder `/Users/flamenom/Obsidian vault/Flamenom/DevDigest/`, 10 notes. The index is
   `DevDigest — огляд.md`. The notes use YAML frontmatter `tags: [devdigest, docs]` and `[[wikilinks]]`.
   - Add one note, `GitLab.md`: what is supported, the token with minimal scopes, adding a repo (nested
     groups, URL forms), sync-on-open, read-only comments, current limitations.
   - Update `Репозиторії та PR.md` for the PR-list sync model: there is no more 60 s auto-refresh, the
     list syncs when opened, and it shows a "Synced N ago" / "Updating…" status.
   - Update `Встановлення та запуск.md` (GitLab token) and the overview map of notes.
   - Write in correct **Ukrainian**, not Russian. Verify every UI label against `client/messages/en/*.json`.

**Acceptance:**
- README lists GitLab and links the spec.
- `GitLab.md` exists and is linked from the overview.
- No note claims the PR list refreshes every 60 s.

### Task B: record engineering insights (small · ready)

**Why:** the root `CLAUDE.md` "Insights loop" requires it at session end, and it was never done for the
GitLab work. Use the `/engineering-insights` skill:
- Re-read the target `INSIGHTS.md` first.
- Insert only; never overwrite.
- Add at most about 5 entries per file, each citing a `file:line`.

Candidates (verify each against the code before writing):
- **`server/INSIGHTS.md`:**
  - `HostGitClient` members are function-typed properties on purpose. With method syntax, TypeScript
    compares parameters bivariantly, so a narrowed `HostRepoRef` param would not be enforced. See
    `server/src/vendor/shared/host-git.ts`.
  - The PR sync coordinator's last-resort `.catch` must release the single-flight slot **before** anything
    that can throw. `describeError` is wrapped so it can't throw (`modules/pulls/sync-coordinator.ts`).
  - Drizzle 0.38 `onConflictDoNothing({ target })` can't express `lower(col)`. The GitLab repo insert
    uses raw SQL built from `sql.identifier(col.name)`, and the partial-index predicate is shared with
    the schema (`db/schema/repos.ts` `reposIdentityWhere`).
  - Drizzle runs all pending migrations in **one transaction**, so a `RAISE EXCEPTION` guard in a
    migration rolls everything back cleanly (`0020`).
- **Root `INSIGHTS.md`** (tooling):
  - The repo is a **fork**. `gh` resolves the *parent* repo (`remote.origin.gh-resolved=base`), so
    always pass `-R Flamenom/dev-digest` to `gh variable|secret|api` commands. An earlier
    `gh variable set` without `-R` wrote into the upstream course repo.
  - `pnpm arch` (dependency-cruiser) refuses Node 23. Run it with
    `PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"`.
  - Pushing changes under `.github/workflows/**` needs a token with the `workflow` scope. The macOS Keychain
    PAT lacks it, so use `git -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' push`
    or run `gh auth setup-git` once.
  - The `rtk` hook wrapper can misreport `eslint`/`grep` output and exit codes (e.g. "JSON parse failed").
    Use `rtk proxy <cmd>` for the raw result.
  - The harness-evals workflow tier needs a model that actually uses Claude Agent SDK tools. The repo
    variable `EVAL_MODEL_WORKFLOW=anthropic/claude-haiku-4.5` is set on the fork; gemini-2.5-flash
    never invokes skills.
  - Integration tests flake occasionally under full-suite load (`reviews.it`, `gitlab-feature-parity`).

**Acceptance:**
- New entries exist in `server/INSIGHTS.md` and the root `INSIGHTS.md`.
- No existing entry is changed.
- Each entry cites a `file:line`.

### Task C: multi-user server mode (large · **spec first**)

**Why:** the team-server goal. Today:
- Auth is `LocalNoAuthProvider` (`server/src/adapters/auth/local.ts`): a seeded system user and one
  default workspace, with every request scoped to it.
- Tenancy columns (`workspace_id`) and `getContext()` (`modules/_shared/context.ts`) already exist.
- PR-list single-flight is **per process** (`modules/pulls/sync-coordinator.ts`). Several API instances
  need a DB advisory lock (e.g. `pg_try_advisory_lock(hashtext(repo_id))`) or one sync owner.
- Provider tokens are per workspace and stored by `LocalSecretsProvider` (a 0600 JSON file) via the
  `SecretsProvider` port. A shared server needs a decision on secret storage.

**Questions the spec must settle (ask the user):**
- Identity provider: GitHub/GitLab OAuth login, an email magic link, or SSO.
- Roles (admin / reviewer / viewer?) and what each may do (settings, tokens, run reviews, accept/dismiss).
- Workspace model: one team workspace, or several.
- Who acts on providers: the service-account token (current) or each user's own token. This matters
  for Task D.
- Deployment target and secret storage.

**How:**
1. `spec-creator` → `specs/YYYY-MM-DD-multi-user-server.md`.
2. Then `implementation-planner`.
3. Then `/run-plan`.

### Task D: GitLab phase 2, posting comments (medium · decide after Task C)

**Why:** GitLab PRs are read-only today. Posting inline comments and replies needs:
- GitLab discussions with a `position` object (`base_sha`/`start_sha`/`head_sha` from `diff_refs`, `new_path`/`old_path`, `new_line`/`old_line`);
- replies to discussions;
- string discussion ids;
- a token with the `api` scope.

**Constraints:**
- The `PrReviewComment` contract (`server/src/vendor/shared/contracts/platform.ts`) has **numeric** ids
  and is extend-only. Add a **new** contract file and never edit the existing one. Mirror it into
  `client/src/vendor/shared` and run `node scripts/check-shared-sync.mjs`.
- The current GitLab behaviour is specified by spec ACs 43–45. Replace them with a new spec that
  supersedes those ACs.
- Depends on Task C: whose identity is used to post (the service account vs. the acting user).

**How:** spec → plan → run-plan. Research estimate from earlier: about 4–6 dev-days.

### Task E: stabilise flaky integration tests (small–medium · ready to investigate)

`server/test/reviews.it.test.ts` ("map-reduce + grounding drops the hallucinated finding") and
`server/test/gitlab-feature-parity.it.test.ts` ("1. review…", once returned 404 on
`POST /pulls/:id/review`) sometimes fail under the full `pnpm exec vitest run`. They always pass alone.

Likely causes:
- shared-state or timing races between testcontainers suites;
- fire-and-forget review runs checked before they finish.

Approach:
1. Reproduce with `--sequence.shuffle` or repeated full runs.
2. Inspect the run executor's async completion and any fixed sleeps.
3. Make the tests await deterministic completion.

**Acceptance:** 10 consecutive full server runs are green.

### Task F: optional technical leftovers (pick as needed)

- **Settings routes still use Drizzle directly** (2 arch warnings). Move them to a settings repository.
- **PR-list rollup** (`readPersistedList` in `server/src/modules/pulls/routes.ts`) could become a
  `PullListService`.
- **Upcast hole:** `HostGitClient` → legacy `GitClient` is still accepted by TS, because `GitClient`'s methods are
  compared bivariantly. It can't be fixed without editing `adapters.ts` (do-not-touch).
  Rule: never write that upcast.
- **Zod tightening inside `contracts/repo-host.ts`** (`web_url` `.url()`, a composed `PrDetailHost`) is
  blocked, because the file is now an existing contract. If it is ever needed, do it with a new file.
- **Course roadmap** (see the README "Roadmap"): L07 multi-agent review, persistent memory and per-agent stats;
  L08 plugin export/import, an agent performance dashboard and a weekly digest.

> Note: an earlier claim that Settings had stub sections was **wrong**. `SETTINGS_SECTIONS`
> (`client/src/vendor/ui/nav.ts`) has only `api-keys` and `models`, and both are implemented.

### Status as of 2026-10-19 (end of session)

Done on branch `feat/gitlab-integration-next-steps`, not merged yet:
- **A:** README and the Obsidian notes cover GitLab.
- **B:** insights recorded.
- **E:** the trace/status race is fixed. 10/10 full runs were green. A rare Docker hook timeout remains; see G6.
- **F:** settings repository and `PullListService`.
- **C:** multi-user server mode is implemented.
  - Spec `specs/2026-10-19-multi-user-server.md` and plan `docs/plans/multi-user-server.md`, 29 tasks.
  - Seven `/pr-self-review` rounds; the last one had 0 critical findings.
  - Migrations `0021`–`0025` are new.

Task D (GitLab comment posting) is still open. It can start now that C is done: it posts as the service account.

### Task G: follow-ups from the multi-user `/pr-self-review` rounds (small each · ready)

None of these block the push. Each needs a test.

1. **Type-safety pass**, removing `as` casts:
   - make `useAgent` return `AgentWithActors` (`client/src/app/agents/[id]/page.tsx:129`);
   - build `toSecretsStatusDto` from a typed provider tuple instead of `as SecretsStatusDetailed` (`server/src/modules/settings/helpers.ts:67`);
   - add an `isAuthzCode` type guard (`client/src/lib/providers.tsx:64`);
   - define `WithAgentActors<T>` via `Omit` (`server/src/modules/agents/helpers.ts:167`);
   - replace `one!` / `dto!` / `ws!` / `user!` with explicit guards;
   - add `Role.safeParse` in `MemberRow`.
2. **Settings dedupe in `0024`:** the dedupe ranks rows by `age(xmin)`, which is not reliable after a dump/restore or a VACUUM FREEZE.
   - `0024` may already be applied somewhere, so do not edit it.
   - If any environment still has per-user duplicates, add a pre-check migration that fails when duplicates hold *different* values.
   - Alternatively, document a backup step.
3. **OAuth callback:** consume the flow atomically with the binding check, `DELETE … WHERE state_hash = $1 AND binding_hash = $2` (`server/src/modules/identity/sign-in-service.ts:223`). With this change, a stray callback can no longer burn a victim's in-flight sign-in.
4. **Audit durability:** `secret.save` and `settings.update` are written fire-and-forget after the response (`platform/auth/audit-hook.ts`). Move them into the service transaction, as the identity services already do. Audit `secret.save` on the write itself, not on the final HTTP status.
5. **Test refactor:**
   - add one shared `renderWithProviders` with a fetch router (or MSW);
   - drop the per-file mocks of `@/lib/hooks` / session / permissions / app-shell / RunStatus;
   - wait on visible output, not on fetch call counts;
   - replace `querySelector('img')` in `ActorLabel.test.tsx`.
6. **Small DB items:**
   - `fillfactor = 90` on `sessions` and `api_tokens`;
   - a batched `replaceMany` in `SecretStoreRepository`;
   - `useCan` / `useIsAdmin` → `lib/hooks/permissions.ts`;
   - one error channel per mutation, so the toast and the inline alert don't both fire;
   - `metadata` for `/sign-in`.
7. **Known flake (Task E leftover):** under heavy Docker load, a testcontainers `beforeAll` sometimes exceeds 120 s. The fix is a shared Postgres via `globalSetup` with a database per file.
8. **`vendor/ui`:** add `aria-disabled` support to `Toggle` / `Checkbox` / `IconBtn`. Members currently get *hidden* controls there, not disabled ones.

---

## 3. How to execute

| Task | Workflow |
|------|----------|
| A, B, E | Direct: one `implementer` / `doc-writer` / the `engineering-insights` skill, then verify |
| C, D | `spec-creator` → user answers the blocking questions → `implementation-planner` (ask single- or multi-agent) → `/run-plan` |
| any code change | before push: `/pr-self-review` (full run; above 40 files it asks for confirmation). The `pr-gate` hook blocks `git push` / `gh pr create` without a fresh passing verdict in `.git/pr-self-review.json`. Write the verdict and push in **separate** commands, because the hook checks the verdict before the command runs. |

**Process rules that worked:**
- Branch from `main` and open one PR per task. Never push to `main`.
- The user merges PRs, because auto-mode blocks `gh pr merge`.
- Run implementers in parallel only when their owned paths don't overlap. **Never `git stash`
  while agents are working in the tree.**
- Chain verification with `&&`, never `;`, before committing or writing a verdict.
- After fixes from a review, re-review the fix commit. Twice it caught a regression the fix had introduced.

**Verification matrix** (all must pass before push):
```
cd server && pnpm typecheck && pnpm test          # needs Docker for *.it.test.ts
cd server && PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" pnpm arch   # 0 errors; warnings ≤ 40 (main baseline)
cd client && pnpm typecheck && rtk proxy pnpm lint && pnpm test
cd reviewer-core && pnpm typecheck && pnpm test
cd mcp && pnpm typecheck && pnpm test
node scripts/check-shared-sync.mjs
./scripts/e2e.sh                                    # 11 flows
```

## 4. Do-not-touch reminders (from `CLAUDE.md`)

- Existing `@devdigest/shared` files are extend-only: add new files, and only append `export *` to
  `index.ts`. Keep the client copy byte-identical.
- Never edit applied migrations (`0000`–`0020` are applied on `main`). Add a new one with
  `pnpm db:generate` (server uses pnpm v11: `npx pnpm@11` if the store version mismatches).
- reviewer-core stays pure, and the grounding gate is never bypassed.
- Never read `.env`, `.mcp.json` or credential files (global secret policy).

## 5. Read before starting

- Every task: root `CLAUDE.md`, root `INSIGHTS.md`.
- A: `README.md`, `specs/2026-10-16-gitlab-merge-requests.md` §Goals and §ACs 1–5 / 36–45 / 55–64.
- B: `.claude/skills/engineering-insights/SKILL.md`, the target `INSIGHTS.md` files.
- C: `docs/architecture.md`, `server/src/adapters/auth/local.ts`, `server/src/modules/_shared/context.ts`,
  `server/src/modules/pulls/sync-coordinator.ts`, `server/src/adapters/secrets/local.ts`.
- D: the GitLab spec (ACs 43–45), `server/src/adapters/gitlab/`, `server/src/vendor/shared/contracts/platform.ts`
  (`PrReviewComment`), `client/src/components/read-only-host/`.
- E: `server/test/reviews.it.test.ts`, `server/test/gitlab-feature-parity.it.test.ts`,
  `server/src/modules/reviews/run-executor.ts`, `server/test/helpers/`.
