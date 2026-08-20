# DevDigest — improvement plan

Full-project audit (client · server · reviewer-core · DB · tooling) against
`frontend-ui-architecture`, `react-best-practices`, `next-best-practices`,
`fastify-best-practices`, `drizzle-orm-patterns`, `postgresql-table-design`,
`zod`, `security`, `typescript-expert`, `react-testing-library`.

**Verdict up front:** the architecture is genuinely good. Layering is declared and
mostly honoured, `reviewer-core` is verifiably pure (no fs/db/octokit imports),
route-local colocation under `_components/` is applied consistently, the DI container
+ static module registry are clean, and comments explain the *why*. The findings below
are concentrated in four places: **the `pulls` server module** (the one module that
skipped the layering), **DB indexes/constraints** (largely absent), **tenancy
enforcement on three `/runs/:id` routes**, and **tooling** (no linter at all).

Legend: **P0** = correctness/security · **P1** = high value · **P2** = polish.

---

## 0. Cross-cutting: no linter exists (P0, cheapest win in the repo)

There is no ESLint, Prettier, or Biome config anywhere — not in root, `client/`,
`server/`, `reviewer-core/`, or `e2e/`. No `lint` script in any `package.json`. No CI
job runs one.

Proof it's already costing something: `client/src/lib/hooks/reviews.ts:212` carries
`// eslint-disable-next-line react-hooks/exhaustive-deps` — a directive suppressing a
rule that nothing enforces. And `page.tsx:72-75` (below) has a genuinely wrong `useMemo`
dependency array that `react-hooks/exhaustive-deps` would have caught on day one.

**Action**
1. `client/`: `eslint-config-next` + `eslint-plugin-react-hooks` + `jsx-a11y`. This alone
   catches the RSC/hook/a11y classes of bug listed throughout this document.
2. `server/` + `reviewer-core/`: `typescript-eslint` with `no-floating-promises`,
   `require-await`, `no-misused-promises` — the fire-and-forget review executor is
   exactly the shape those rules protect.
3. One shared Prettier config at root; add `lint` to the 5 CI workflows.

---

## 1. Server — the `pulls` module bypassed the project's own layering (P0/P1)

`server/CLAUDE.md` states the convention: `routes → service → repository`. Seven of
eight modules follow it. `pulls` does not — `server/src/modules/pulls/routes.ts` is 393
lines of route handler containing raw Drizzle queries, Octokit calls, and the
score/cost/findings aggregation business logic inline. It is the largest route file in
the codebase and the only module without `service.ts` / `repository.ts`.

### 1.1 `GET` endpoints perform destructive writes (P0)

`GET /repos/:id/pulls` (`routes.ts:26`) writes: it upserts every PR from GitHub
(`:46-74`) and back-fills diff stats (`:94-111`). `GET /pulls/:id` (`routes.ts:229`) is
worse — at `:251-274` it **deletes all `pr_files` and `pr_commits` rows, then
re-inserts them, with no transaction**:

```ts
await container.db.delete(t.prFiles).where(eq(t.prFiles.prId, pr.id));
if (detail.files.length > 0) { await container.db.insert(t.prFiles).values(...) }
```

If the insert fails (constraint, connection drop, process exit), the PR's diff is gone
and the only recovery is another successful GitHub fetch. A read request must not be
able to destroy persisted data.

**Action**
- Wrap the delete+insert in `db.transaction()` (Drizzle: `await db.transaction(async tx => …)`).
- Better: move the sync out of the GET. Introduce `POST /repos/:id/pulls/sync` and
  `POST /pulls/:id/refresh`; the client already has `useRefreshRepo`. GETs become
  genuinely read-only, idempotent, and cacheable.
- Return a `sync_status` field so the six `log.warn`-and-continue branches
  (`:38, :76, :109, :289, :348, :354`) become visible to the user instead of silently
  serving stale data.

### 1.2 N+1 writes and sequential network fetches in a request handler (P1)

- `routes.ts:46-74` — one `INSERT … ON CONFLICT DO UPDATE` per PR inside a `for` loop.
  Drizzle accepts an array: one statement for the whole page.
- `routes.ts:94-111` — up to 10 sequential GitHub detail fetches + 10 `UPDATE`s inside
  the request. This is on the critical path of the PR-list render.
- `modules/reviews/service.ts:164-170` — `reviewsForPull` looks up each agent's name in
  a loop (`await this.agents.getById(...)` per distinct agentId). Replace with one
  `inArray(agents.id, ids)` query.
- `modules/reviews/service.ts:119-129` — one `createAgentRun` INSERT per target agent;
  batchable.

### 1.3 Aggregation logic belongs in SQL or a service, not a route (P1)

`routes.ts:114-198` computes "latest review per (pr, agent) → worst score, summed
severities, summed cost" with three queries and ~80 lines of JS `Map` juggling. This is
`DISTINCT ON (pr_id, agent_id) … ORDER BY created_at DESC` plus two grouped
aggregates. Even keeping it in JS, it belongs in `PullsService`.

### 1.4 No pagination (P2)

`GET /repos/:id/pulls` returns every row for the repo, unbounded, and the client polls
it every 60s (`client/src/lib/hooks/core.ts:109`).

### 1.5 Inconsistent workspace scoping (P2 now, P0 when auth lands)

`server/CLAUDE.md`: *"Every domain table carries `workspace_id`; resolve tenancy via
`getContext()`."* Several queries resolve the repo/PR with a workspace filter and then
join onward without one — `routes.ts:80-83` (pullRequests by repoId only),
`:238-241` and `:333` (repos by id only). Reachability makes these safe *today*; they
are the pattern that breaks the moment a second workspace exists.

---

## 2. Server — three `/runs/:id` routes resolve tenancy and then discard it (P0)

`security` skill, OWASP A01 (Broken Access Control). In
`server/src/modules/reviews/routes.ts` three handlers call `getContext()` — establishing
the caller's workspace — and then **throw the result away**, passing only the raw id
down:

| Route | Line | Downstream |
|---|---|---|
| `GET /runs/:id/trace` | `routes.ts:121-126` | `service.getRunTrace(runId)` → `repository/run.repo.ts:187` — `where(eq(runTraces.runId, runId))`, no workspace filter |
| `POST /runs/:id/cancel` | `routes.ts:114-118` | `service.cancelRun(runId)` — cancels + completes the bus, unscoped |
| `GET /runs/:id/events` | `routes.ts:48-52` | `runBus.subscribe(runId, …)` — subscribes to any run's live log |

`DELETE /runs/:id` (`routes.ts:107`) *does* scope correctly — so this is inconsistency,
not a blanket omission. Run traces contain the full assembled prompt and model output;
under `LocalNoAuthProvider` there is one workspace so nothing leaks today, but these are
textbook IDORs the moment auth is real.

**Action** — thread `workspaceId` through all three: `getRunTrace(workspaceId, runId)`
joining `agent_runs`, `cancelRun(workspaceId, runId)` guarded by
`cancelRunIfRunning(workspaceId, runId)`, and an ownership check before
`runBus.subscribe`. Add an integration test asserting a foreign workspace gets 404.

---

## 3. Security — repo URL validation is a substring match, not a host check (P0)

`server/src/modules/repos/constants.ts:18`:

```ts
export const GITHUB_URL_REGEX = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?\/?$/;
```

Combined with `RepoInput = z.object({ url: z.string().url() })`
(`vendor/shared/contracts/platform.ts:135`), and the raw URL being handed to
`git clone` at `modules/repos/service.ts:54-57`. Two concrete problems:

**a) Path traversal via `owner`.** `[^/]+` accepts `..`. Input
`https://github.com/../evil` parses to `owner: "..", name: "evil"`; the clone path is
`join(cloneDir, "..", "evil")` (`adapters/git/simple-git.ts:37`) — outside the
configured clone directory.

**b) Arbitrary-host clone / SSRF.** The regex is unanchored at the start — it only
requires `github.com/` to appear *somewhere*. `https://internal-host/github.com/a/b`
matches, and `service.ts:54` clones from that raw URL. `z.string().url()` also permits
`file://` and `http://169.254.169.254/...`.

Mitigating: `withGitHubToken` (`modules/repos/helpers.ts:32`) correctly gates token
injection on `u.hostname === 'github.com'`, so the PAT is **not** leaked to a foreign
host. Good defensive coding — it limits this to unauthenticated fetch.

**Action** — parse, don't regex:

```ts
const u = new URL(url);                              // reject non-URLs
if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new AppError(...);
const [owner, name] = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
if (!/^[A-Za-z0-9._-]+$/.test(owner) || owner === '..' /* + same for name */) throw …;
```

Keep the SSH form as a separate explicit branch. Add unit tests for `..`,
`https://evil.com/github.com/a/b`, and `file:///…`.

### 3.1 Secondary security items (P2)

- **Secrets at rest** — `~/.devdigest/secrets.json` is plaintext. `writeFile` sets mode
  `0o600` but `mkdir` (`adapters/secrets/local.ts:47`) doesn't set `0o700`, so the
  directory inherits umask (typically `0755`). Add `{ recursive: true, mode: 0o700 }`.
- **No log redaction** — Pino is configured at `app.ts:50-59` without `redact`. Provider
  keys and the GitHub PAT could reach logs through an error object. Add
  `redact: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.token']`.
- **CORS origin is not configurable** — `config.ts:77` hardcodes
  `http://localhost:${WEB_PORT}`. Add a `WEB_ORIGIN` env var.
- **Boolean env parsing** — `EMBEDDINGS_ENABLED: z.string().optional()` then
  `=== 'true'` (`config.ts:22, 78`). Per the `zod` skill, model it as a real boolean
  (`z.preprocess`/`z.stringbool`) so `1`, `TRUE`, `yes` don't silently mean *false*.

---

## 4. Database — indexes and constraints are largely missing (P0 for indexes)

`postgresql-table-design` + `drizzle-orm-patterns`. `src/db/schema/pulls.ts`,
`repos.ts`, `context.ts`, `repo-intel.ts`, `core.ts`, `knowledge.ts`, `ops.ts` all
declare indexes. **`reviews.ts` and `runs.ts` declare none** — and they carry the
hottest queries in the app.

### 4.1 Missing indexes (P0)

| Table | Queried by | Where |
|---|---|---|
| `reviews` | `prId` (+ `kind`, ordered by `createdAt desc`) | `pulls/routes.ts:145`, `reviews/repository.ts` |
| `findings` | `reviewId` (`inArray`, per PR-list render) | `pulls/routes.ts:172` |
| `agent_runs` | `(workspaceId, prId)`, `prId`, `status` | `pulls/routes.ts:192`, active-runs poll, boot reaper |
| `run_traces` | PK is `runId` — fine | — |

Every PR-list render does an unindexed `inArray` scan of `findings`; the client polls
that endpoint every 60s per open tab. Add via a new migration (never edit applied SQL):
`reviews(pr_id, kind, created_at DESC)`, `findings(review_id)`,
`agent_runs(workspace_id, pr_id)`, `agent_runs(status)`.

### 4.2 Missing referential integrity (P1)

`schema/reviews.ts:17-19` — `agentId` and `runId` are bare `uuid()` columns with **no
`.references()`**, while `schema/runs.ts:13-14` correctly declares them for
`agent_runs`. So `reviews.run_id` can point at a deleted run, and `reviews.agent_id` at
a deleted agent. Note the deliberate design choice this must respect: `agent_runs` uses
`onDelete: 'set null'` to preserve history. Mirror that (`references(() => agentRuns.id,
{ onDelete: 'set null' })`) rather than cascading.

### 4.3 Missing value constraints (P1)

The schema uses `text(..., { enum: [...] })` in some places (`reviews.kind`,
`agentRuns.source`) and bare `text()` in others for equally closed sets:

- `findings.severity` (`reviews.ts:36`) — bare text, yet `rollupSeverities` buckets it
  into exactly `CRITICAL | WARNING | SUGGESTION` (`pulls/routes.ts:180`). A typo'd
  severity is silently dropped from every count in the UI.
- `findings.category`, `findings.kind` — same.
- `agentRuns.status` (`runs.ts:23`) — bare text, compared against `'running'` /
  `'failed'` / `'cancelled'` throughout, including the boot reaper.
- `findings.confidence` (`reviews.ts:41`) — `doublePrecision` with no `CHECK (confidence
  BETWEEN 0 AND 1)` despite being rendered as a percentage.
- `findings` has no `createdAt`, so findings can't be ordered independently of review.

---

## 5. Client — App Router is being used as a client-only SPA (P1, architectural)

`next-best-practices` (RSC boundaries) + `frontend-ui-architecture` §7. Of 113 `.tsx`
files, 53 are `"use client"`. In `app/` **only three non-test files are Server
Components** — `layout.tsx`, `agents/page.tsx`, `settings/[section]/page.tsx` — and all
three do nothing but render a client view. **Zero server-side data fetching exists in
the app.** Every screen ships as JS, mounts, then fetches.

The skill's rule: *Server Components are the default; push `"use client"` down to the
interactive leaves.* Here the boundary sits at the top of every route, so the whole
subtree is dragged client-side.

This is a defensible choice for a local studio, and TanStack Query + SSE genuinely need
the client. **But it should be a documented decision, not a default** — and two things
follow from it either way:

- `client/CLAUDE.md` should state "the studio is deliberately CSR; RSC is used for the
  shell only", so future lessons don't fight the grain.
- The parts that *don't* need interactivity should move: static page shells, headers,
  `OverviewTab` (renders `pr.body` markdown), and breadcrumbs are pure presentation. The
  quickest real win is making `pulls/page.tsx` and `pulls/[number]/page.tsx` thin Server
  Components that prefetch into a `HydrationBoundary`, leaving the interactive tables and
  tabs as client leaves. That kills the initial fetch waterfall without changing the
  data layer.

### 5.1 No `error.tsx`, `not-found.tsx`, or `loading.tsx` anywhere (P1)

None of these files exist in `client/src/app/`. Consequences:

- **Any render-time throw crashes the whole app** to Next's default error screen. Every
  route hand-rolls its own `<ErrorState>` for *fetch* errors
  (`pulls/page.tsx:113`, `pulls/[number]/page.tsx:110`) but nothing catches a render
  throw. `react-best-practices` calls for error boundaries with `resetKeys={[pathname]}`
  and a "Try again" that calls `resetErrorBoundary`.
- **`not-found.tsx`** — the app instead invented `RepoNotFound` +
  `useRepoNotFound()` (`lib/repo-context.tsx:69`) and every repo-scoped page repeats the
  same early-return block (`pulls/page.tsx:64-70`, `pulls/[number]/page.tsx:90-96`).
  Next's `notFound()` + one `not-found.tsx` replaces that duplication.
- **`loading.tsx`** — each page hand-rolls a Skeleton stack instead.

Add `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`, and per-route
`loading.tsx`. This is the single highest ratio of robustness to lines of code on the client.

### 5.2 Fonts: `next/font` is not used (P1, easy)

`app/globals.css:8-14` declares `@font-face { font-family: "Inter"; src: local("Inter") }`.
`local()` resolves against fonts **installed on the viewer's machine**. Anyone without
Inter installed silently gets the fallback — the app renders differently per machine
with no signal. Replace with `next/font/google`'s `Inter` (self-hosted, zero layout
shift, preloaded) per the `next-best-practices` font guidance.

### 5.3 i18n: every namespace ships to the client on every route (P1)

`i18n/request.ts:20-28` reads **all** of `messages/en/*.json` and merges them;
`app/layout.tsx:28` passes the whole object to `NextIntlClientProvider`. That's 18
namespaces (~35 KB of JSON) serialized into the RSC payload of every page — including
`eval.json`, `ci.json`, `skills.json`, `conformance.json`, `blast.json` and others whose
screens don't exist yet.

**Action** — pass only the namespaces a route needs (next-intl supports scoping the
provider's `messages`), or move `NextIntlClientProvider` down from the root layout.

Second issue: `loadMessages` uses `readdirSync(join(process.cwd(), 'messages', locale))`.
That breaks under `output: 'standalone'` unless `messages/` is explicitly copied, and it
means an unreadable directory is a hard boot failure with no fallback.

### 5.4 i18n coverage is half-applied (P2)

35 files use `useTranslations`. But `pulls/[number]/page.tsx` — one of the two main
screens — is fully hardcoded English (`:115` `"Couldn't load this pull request"`, `:153`
`"Delete this run from history?"`), as is `app/page.tsx`. Either finish the pass or drop
next-intl; a half-translated app is worse than either end state.

---

## 6. Client — component/hook issues (`react-best-practices`)

### 6.1 Wrong `useMemo` dependency array (P0 — a real bug waiting)

`app/repos/[repoId]/pulls/[number]/page.tsx:72-75`:

```ts
const allFindings: FindingRecord[] = React.useMemo(
  () => runs.flatMap((r) => r.findings),
  [reviews],                     // ← reads `runs`, depends on `reviews`
);
```

It happens to be correct only because `runs === reviews ?? []` on the line above. Any
future change to how `runs` is derived produces a stale memo with no warning. The memo
also isn't earning its keep — a `flatMap` over a handful of reviews is not an expensive
computation, and the skill is explicit that `useMemo` is for *measured* costs. Delete
it. (`react-hooks/exhaustive-deps` would have flagged this — see §0.)

### 6.2 `FindingsTab` takes 14 props, including a live mutation object (P1)

`_components/FindingsTab/FindingsTab.tsx:12-27`. Against the skill's 5–7 prop guidance,
and one prop is:

```ts
cancelMutation: UseMutationResult<any, any, string, any>;   // three `any`s
```

A TanStack Query mutation handle passed through a presentational prop boundary. The
component then calls `cancelMutation.mutate` (`:45`) and reads `.isPending` (`:97`) — it
*is* a container, so it should own that state: call `useCancelRun()` inside it. Same for
`onRunDone`/`onDelete`, whose bodies are cache-invalidation logic living in the page
(`page.tsx:51-58, 152-160`) — that belongs in the mutation hooks' `onSuccess`, which is
exactly the pattern `lib/hooks/reviews.ts:66-69` already uses correctly for
`useDeleteRun`. Removing the drilled props deletes ~30 lines from the page.

Also in that file: four `useCallback`s (`:48-64`) that are pure pass-throughs
(`handleOpenTrace = useCallback(id => onOpenTrace(id), [onOpenTrace])`). Zero value —
the skill's "wrappers that only pass props through" anti-pattern. Delete them.

### 6.3 Context values are new objects on every render (P1)

- `lib/repo-context.tsx:52` — `value={{ repoId, setRepoId, repos: list, activeRepo, reposLoaded }}`
- `lib/theme.tsx:36` — `value={{ theme, toggle, set }}`

Both providers wrap the entire app. A new object identity each render re-renders **every
consumer** (`useActiveRepo` is called on every repo-scoped page and in the shell). Wrap
in `useMemo`. While there: both `createContext` defaults are silent no-op stubs, so a
component used outside its provider fails invisibly instead of throwing — prefer
`createContext<T | null>(null)` + a hook that throws.

### 6.4 URL state handled three different ways in one screen (P1)

`react-best-practices`: *"URL-dependent state (filters, pagination, search) belongs in
URL search params."* In `pulls/page.tsx`:

- `status` → URL (`:39-44`)
- `query` → `useState` (`:46`)
- `sort` → `useState` (`:47`)

…while the file's own header comment claims *"Filters/sort live in query
(?status&sort)"*. The comment is wrong. Search and sort are lost on reload and
unshareable. Meanwhile `pulls/[number]/page.tsx:62-67` hand-rolls the same
`URLSearchParams` + `router.replace` dance for `?tab` and `?trace`.

**Action** — one `useQueryParam(key, default)` hook in `lib/hooks/`, used by both pages
for all five params.

### 6.5 Derived logic sitting in the component body (P2)

`pulls/page.tsx:49-61` — filter + search + sort + two counts, inline. There is already
a `helpers.ts` in that folder holding `sizeOf`/`relativeTime`. Move
`filterAndSortPulls(pulls, {status, query, sort})` and the counts there: pure, trivially
unit-testable, and it shrinks the component to render logic.

### 6.6 `window.confirm` for a destructive action (P2)

`pulls/[number]/page.tsx:152-155` — blocking native dialog, unstyled, untestable via
RTL, inconsistent with the app's own `Modal`. The design system already ships `Modal`;
use it.

### 6.7 Inline `style={{…}}` objects contradict the stated convention (P2)

`client/CLAUDE.md`: *"Folder per component: `styles.ts` = `CSSProperties` object."*
Honoured almost everywhere — but not in the two main route files:
`pulls/[number]/page.tsx:101` and `:136` build layout objects inline, `app/page.tsx:25`
and `:40` too, and `FindingsTab.tsx:116, 126, 138, 155` mixes `s.*` lookups with inline
literals in the same JSX. `pulls/[number]/` has no `styles.ts` while its sibling
`pulls/` does. Pure consistency cleanup — but per §1 of the architecture skill,
inconsistency costs more than any single choice.

### 6.8 Deep relative imports where an alias exists (P2)

`tsconfig.json` maps `@/*` → `./src/*` and `pulls/page.tsx` uses it throughout. Yet the
sibling `pulls/[number]/page.tsx` mixes both in one file — `@/components/repo-not-found`
on line 12, `../../../../../components/app-shell` on line 11,
`../../../../../lib/hooks` on line 18. Also `:17` default-imports `RunTraceDrawer` while
every other component is a named import. Normalize on `@/` + named imports (an ESLint
`no-restricted-imports` rule enforces it).

---

## 7. Client — SSE hook is the most fragile code in the app (P1)

`lib/hooks/reviews.ts:168-216`, `useRunEvents`:

- **Unbounded state growth** (`:185`) — `setEvents(prev => [...prev, parsed])` allocates a
  new array per event and re-renders every consumer. A long review on a large diff streams
  hundreds of events; the Live Log grows without a cap. Cap the buffer (keep the last N)
  or batch with a ref + interval flush.
- **"Done" is inferred from an error** (`:200-204`) — the server ends the stream, the
  browser reports that as `onerror`, and the hook treats it as completion. A genuine
  network failure and a clean finish are indistinguishable, so a dropped connection reads
  as "review finished". Emit an explicit `done` event server-side (`runBus.complete`
  already exists) and close on that.
- **No resume** — the server sets `id: String(e.seq)` (`reviews/routes.ts:81`), which
  exists precisely so a reconnect can send `Last-Event-ID`. Because `onerror` calls
  `es.close()`, that mechanism is never used and any reconnect loses events.
- **`key = runIds.join(",")` + `eslint-disable exhaustive-deps`** (`:171, 212`) — the
  suppressed-lint smell from §0.
- **`EventSource` can't send headers**, so this path has no route to authentication. Worth
  a comment now; a `fetch`-based SSE reader when auth lands.

---

## 8. Accessibility (P1 — one component fixes most of it)

`react-best-practices` a11y section. The baseline is better than average: `IconBtn` takes
a `label` and renders `aria-label`, `Dropdown`/`CommandPalette`/`ShortcutsHelp` set roles.
But `vendor/ui/kit/Modal.tsx` — the base for every dialog in the app — is missing
essentially all dialog behaviour:

- No **Escape** handler (the skill requires an escape path).
- No **focus trap**; no initial focus; no focus restore to the trigger on close.
- `role="dialog"` + `aria-modal="true"` with **no `aria-labelledby`** pointing at the
  title it already renders (`:54`).
- **Not portalled** — rendered inline, so any ancestor with `overflow: hidden` or a
  competing `z-index` clips it.
- Body scroll isn't locked; the backdrop (`:22`) is a click-only `div`.

Fixing `Modal` (and auditing `Drawer` the same way) fixes every dialog at once. Add
`aria-live="polite"` to the toast region and the Live Log — there's currently exactly one
`aria-live` in the codebase.

---

## 9. Testing (P1)

`react-testing-library` skill. Counts: server 22 test files, client 13, reviewer-core 3.
Server and engine coverage is solid; the client has real gaps.

- **`lib/` is untested** — `api.ts` (the only `fetch` in the app: error normalization,
  the `ApiError` taxonomy, the 204 path), all of `lib/hooks/*`, `repo-context.tsx`,
  `theme.tsx`. These are the highest-leverage units in the client and the easiest to test.
- **No page-level tests** — the 13 tests cover leaf components; `pulls/page.tsx` and
  `pulls/[number]/page.tsx` hold the number→uuid resolution, filtering, and tab routing,
  and are untested. Cover the four states the skill names: loading, error, empty, success.
- **`useRunEvents` is untested** — the most fragile code in the app (§7). Testable with a
  fake `EventSource`.
- **Brittle assertions** — `test/smoke.test.tsx:24-25` asserts
  `getAllByText("Primary").length > 0`, i.e. a design-system gallery is pinned to visible
  English copy. Prefer role-based queries per the skill's query priority.
- **`Gallery` placement** — `src/components/showcase/` sits in the shared production
  components directory but its only consumer is a test. Per
  `frontend-ui-architecture` §2, `components/` is for UI shared by 2+ *routes*. It also
  imports the entire design system, Recharts and Mermaid, so it's a bundle risk if anyone
  ever imports it from a route. Move it to `src/test/fixtures/` or an
  `app/(dev)/showcase/` route group.

---

## 10. Documentation drift (P2)

- `client/src/vendor/ui/README.md` — *"Every component is rendered by the **`/showcase`**
  route"*. **No `app/showcase/page.tsx` exists.** The gallery is test-only. Either add
  the route (useful — it's the design-system reference, and an `app/(dev)/` route group
  is the right home) or fix the README.
- `client/src/app/repos/[repoId]/pulls/page.tsx:2` — *"Filters/sort live in query
  (?status&sort)"*. Sort lives in `useState` (§6.4).
- `INSIGHTS.md` "What Works" and "What Doesn't Work" sections are empty despite real
  learnings sitting in the per-package files.

---

## 11. Notable good practice worth preserving

Not everything needs changing; these are the load-bearing decisions to keep:

- **`reviewer-core` purity is real, not aspirational** — grepping the whole package for
  `node:fs`, `child_process`, `drizzle`, `octokit`, `process.env` returns one match, and
  it's inside a comment. The engine is genuinely portable between the studio and the CI
  runner.
- **Cost estimation is injected, not imported** (`llm/openrouter.ts:35`) — keeps the
  pricing table out of the engine. Textbook dependency inversion.
- **`config.ts:9-13`** — the comment explaining *why* secret keys are deliberately
  absent from the config schema. Prevents exactly the drive-by "fix" that would break the
  `SecretsProvider` chokepoint.
- **`app.ts:70-85`** — stale-run reaping, awaited before `listen`, with the race it
  closes *and* its single-instance assumption both documented.
- **`app.ts:135-142`** — matching `ZodError` by shape because `instanceof` fails across
  duplicate vendored zod instances. A non-obvious trap, caught and explained.
- **Route-local colocation** (`_components/<Name>/{Name.tsx, index.ts, styles.ts,
  constants.ts, helpers.ts}`) applied consistently across ~25 components — the
  `frontend-ui-architecture` recommendation, already in place.
- **`withGitHubToken` gates on exact hostname** (`repos/helpers.ts:32`) — the reason the
  URL-validation bug in §3 doesn't also leak the PAT.

---

## Suggested order of work

| # | Item | § | Effort | Why first |
|---|---|---|---|---|
| 1 | ESLint + Prettier + CI lint | 0 | S | Prevents the whole class; would have caught §6.1 |
| 2 | DB indexes migration | 4.1 | S | Pure win, no code change, hottest queries |
| 3 | Fix `useMemo` deps; delete pass-through `useCallback`s | 6.1, 6.2 | S | Latent bug + dead code |
| 4 | Repo URL validation (parse, don't regex) + tests | 3 | S | Traversal + SSRF |
| 5 | Scope the three `/runs/:id` routes by workspace | 2 | S | IDOR before auth lands |
| 6 | Transaction around the `pr_files` delete+insert | 1.1 | S | Prevents data loss |
| 7 | `error.tsx` / `global-error.tsx` / `not-found.tsx` / `loading.tsx` | 5.1 | S | Biggest robustness-per-line on the client |
| 8 | `next/font` for Inter | 5.2 | S | Silent per-machine rendering bug |
| 9 | Split `pulls` into routes → service → repository; batch the N+1s; GETs read-only | 1 | L | The one module off-convention |
| 10 | Modal a11y (Escape, focus trap, portal, `aria-labelledby`) | 8 | M | Fixes every dialog at once |
| 11 | `useQueryParam` hook; move `sort`/`query` to URL | 6.4 | M | Removes three duplicated patterns |
| 12 | `FindingsTab` owns its mutations; invalidation into hooks | 6.2 | M | Deletes ~30 lines from the page |
| 13 | Scope i18n messages per route | 5.3 | M | Payload on every page |
| 14 | SSE: explicit `done` event, capped buffer, `Last-Event-ID` | 7 | M | Fragile + user-visible |
| 15 | Tests for `lib/api.ts`, `lib/hooks/*`, both pages | 9 | M | Highest-leverage untested code |
| 16 | FK + CHECK constraints; `findings.createdAt` | 4.2, 4.3 | M | Integrity |
| 17 | RSC boundary decision — document it, then prefetch the two main routes | 5 | L | Architectural; needs a decision first |
| 18 | Style/import consistency; doc drift; `Gallery` relocation | 6.7, 6.8, 10, 9 | M | Consistency |
