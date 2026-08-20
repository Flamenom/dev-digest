# 04 — Intent Layer (L03): PR intent → classify → persist → scoped review

Status: **planned** (2026-08-21). Cross-package (server + client + shared contracts +
reviewer-core). Gives the reviewer a structured explanation of WHY a PR exists and what is
in/out of its scope: a cheap flash-class model (via OpenRouter) classifies intent from PR
metadata + linked sources, the intent is persisted per PR, injected into the reviewer
prompt, out-of-scope findings are filtered (one severe signal always survives), and an
Intent card renders on the PR Overview tab above the description.

**Locked decisions** (2026-08-21):
- **No arbitrary URL fetching in v1.** Sources fetched: GitHub linked issue (existing
  adapter) + repo-relative docs via `git.readFile`. External non-GitHub URLs are recorded
  as `unavailable` sources — honest missing-context marking, never fabricated content.
  A guarded `UrlFetcher` port is an explicit follow-up, not part of this feature.
- **"Severe" out-of-scope = `CRITICAL` only.** Only CRITICAL findings tagged out-of-scope
  keep the single surviving signal; WARNING and below are dropped (with logged reasons).

---

## 1. Pre-existing scaffolding (reused, not rebuilt)

| Piece | Where |
|---|---|
| Frozen `Intent` contract (`intent`, `in_scope[]`, `out_of_scope[]` — summary field is named `intent`) | `*/vendor/shared/contracts/brief.ts:9-14` — untouched |
| `PrIntentRecord` (Intent + pr_id) | `contracts/review-api.ts:60-61` — untouched |
| `pr_intent` table (applied migration `0000`) | `server/src/db/schema/reviews.ts:85-92` |
| `upsertIntent` / `getIntent` repo methods | `server/src/modules/reviews/repository/pull.repo.ts:49-68`, exposed `repository.ts:130-136` |
| Feature model `review_intent` + `resolveFeatureModel` + auto-rendered Settings picker | `contracts/platform.ts:51-57`, `server/src/modules/settings/feature-models.ts:51-57`, `SettingsModels.tsx` |
| Executor comments reserving "diff + intent once" shared pre-work | `server/src/modules/reviews/run-executor.ts:40,53,63-65` |
| `INJECTION_GUARD` already names "derived intent/scope", promises scope never zeroes a real defect | `reviewer-core/src/prompt.ts:16-28` |
| Linked-issue resolution regex + `getIssue` | `server/src/adapters/github/octokit.ts:127-135,351-364` |
| `MockLLMProvider.structuredBySchema` (keyed on schemaName) | `server/src/adapters/mocks.ts:44-56,89-96` |
| i18n keys `block.intent`, `unavailable`, `unavailableHint` | `client/messages/en/brief.json` |

## 2. Contracts (new file `contracts/intent.ts`, vendored ×2 byte-identical)

`*/vendor/shared/contracts/intent.ts` + one export line in both `index.ts` barrels.
Frozen files are never edited; extending frozen shapes in a NEW file is the established
mechanism. New optional fields use `.nullish()` (INSIGHTS: required-but-null trap).

- `IntentSourceKind = z.enum(['pr_description','linked_issue','repo_doc','external_url'])`
- `IntentSourceStatus = z.enum(['fetched','unavailable'])`
- `IntentSource = { kind, ref: string, title: string nullish, status }`
- `IntentConfidence = z.enum(['high','low'])`
- `IntentClassification` — LLM output schema with `.max()` size caps (hallucination guard):
  `{ summary, in_scope[] ≤8, out_of_scope[] ≤8, risk_areas[] ≤6 (each ≤80 chars) }`.
  Service maps `summary` → frozen `intent` field at the boundary.
- `IntentDetail` — API response: `Intent.extend({ pr_id, risk_areas, confidence, sources,
  model nullish, head_sha nullish, generated_at, stale: boolean })`
- `ScopedFinding = Finding.extend({ scope: z.enum(['in','out']).nullish() })`;
  `ScopedReview = Review.extend({ findings: ScopedFinding[] })` — reviewer output schema
  when intent is present. `scope` is stripped before persistence.

## 3. DB delta (migration `0014`, additive only)

`pr_intent` gains: `risk_areas jsonb NOT NULL DEFAULT '[]'`, `confidence text NOT NULL
DEFAULT 'low'` (text, not pg enum), `sources jsonb NOT NULL DEFAULT '[]'`, `model text`,
`head_sha text`, `tokens_in int`, `tokens_out int`, `cost_usd` (match `agent_runs` type),
`created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`. All nullable-or-defaulted so
rows from applied `0000` survive. Generated via `pnpm db:generate`; applied SQL never edited.

New repo methods `upsertIntentDetail` / `getIntentDetail` beside the existing pair
(untouched); row→domain mapping at the repository boundary.

## 4. Server module `modules/intent/`

`constants` · `prompts` · `helpers` · `service` · `routes`; registered in
`modules/index.ts` (comment there already reserves `intent`). Modeled on
`modules/conventions/` — the existing non-reviewer LLM feature.

- `prompts.ts`: module-local `INJECTION_GUARD` + `wrapUntrusted` (conventions precedent).
  Every author-controlled block (PR body, issue text, doc excerpts) is untrusted-wrapped.
  File list rendered as `path` + `@@ -a,b +c,d @@` hunk headers only — **diff bodies are
  never sent to the classifier**.
- `helpers.ts` (pure): `extractIssueRef` (closes/fixes/resolves #N), `extractRepoDocPaths`
  (repo-relative `specs/*.md` / `docs/*.md` mentions), `extractExternalUrls`,
  `hunkHeadersFromPatch` (empty patch → path only), `computeConfidence`, `toIntentDetail`
  (`stale = row.head_sha !== pull.headSha`).
- **Confidence is deterministic in code, never model-self-reported**: `low` when
  (body empty AND no source fetched) OR any referenced source is `unavailable`; else `high`.
- `service.ts`: `IntentService` with an **explicit deps object** built in the container
  (`{ reviewRepo, github, git, llm, resolveModel }` — not `constructor(container)`; no new
  arch-backlog entries). Methods:
  - `get(workspaceId, prId)` → `IntentDetail | null`
  - `classify(workspaceId, prId)` — gather sources (body → `fetched` when non-empty;
    linked issue via `getIssue`, failure ⇒ `unavailable`; repo docs via `git.readFile`,
    throw ⇒ `unavailable`; external URLs ⇒ `unavailable`, v1 locked decision); one
    `completeStructured({ schema: IntentClassification, schemaName: 'IntentClassification',
    model })` with `resolveFeatureModel(ws, 'review_intent')`; compute confidence; upsert
    with `head_sha`, tokens, cost from `StructuredResult`.
  - `getOrClassifyFresh(workspaceId, pull)` — stored intent with matching `head_sha` →
    return; else classify inline (persisting).
- `routes.ts` (thin, `ZodTypeProvider`, tenancy via `getContext`):
  - `GET /pulls/:id/intent` → `IntentDetail`; 404 when none (client 4xx-silent convention).
  - `POST /pulls/:id/intent` → synchronous re/classification (one cheap LLM call —
    conventions sync-POST precedent).
- Container: lazy getter `container.intentService` (repoIntel-facade precedent); routes and
  the reviews executor both consume it — no sibling module imports.

## 5. Review-pipeline integration

- **Executor** (`run-executor.ts`): after the diff step, best-effort
  `runLog.step('Resolving PR intent', () => intentService.getOrClassifyFresh(...))` in
  try/catch — **intent failure never fails a review** (degrades to today's no-intent
  behavior). Resolved model + confidence + source statuses go to the run log (no bodies).
  Passed to `reviewPullRequest` via the `...(intent ? { intent: {...} } : {})` idiom.
- **reviewer-core prompt** (`prompt.ts`): new optional `intent` in `PromptParts` +
  `ReviewInput`; section `## Declared PR intent & scope` rendered inside
  `wrapUntrusted('derived-intent', …)` before the PR description; a **trusted-side**
  instruction (outside untrusted blocks) tells the model to tag each finding
  `scope: 'in' | 'out'` and restates that scope never waives severity.
  `PromptAssembly` (`trace.ts`) is deliberately NOT extended — the section is visible
  inside `assembly.user`.
- **reviewer-core output**: with intent present, `completeStructured<ScopedReview>` keeping
  `schemaName: 'Review'` (mock fixtures keyed on `'Review'` keep working). Without intent,
  behavior is byte-identical to today.
- **Scope filter** — new pure `reviewer-core/src/review/scope.ts`, applied **after**
  `groundFindings`, before the deterministic re-score:
  `applyScopeFilter(findings) → { kept: Finding[], dropped: [{finding, reason}] }`
  - untagged / `'in'` → kept as-is;
  - `'out'` + `severity === 'CRITICAL'` (locked decision) → exactly ONE kept (highest
    severity, tiebreak confidence desc, then stable order) with a deterministic rationale
    prefix `**[Out of declared PR scope — kept as the single out-of-scope signal]**`;
    the rest dropped with reasons;
  - `'out'` non-critical → dropped with reasons;
  - every drop emitted as an event (grounding precedent — never silent);
  - `scope` key stripped from kept findings (DB/API see only frozen `Finding`s);
  - final score recomputed from the post-scope kept set. Grounding gate untouched.

## 6. Settings

Flip `review_intent` default from `openai / gpt-4.1` to **`openrouter /
google/gemini-2.5-flash-lite`** ($0.10/M in, $0.40/M out, confirmed OpenRouter
structured-outputs support) in all three registries in lockstep:
`server/.../contracts/platform.ts`, `client/.../contracts/platform.ts`,
`client/src/lib/feature-models.ts`. Value-only edit — no shape change. The Settings →
Models picker already renders the entry; no UI work.

## 7. Client

- Hook `lib/hooks/intent.ts` (+ barrel): `usePrIntent(prId)` — key `["pr-intent", prId]`,
  404 → empty state; `useClassifyIntent(prId)` — POST, `onSuccess: setQueryData`.
- `OverviewTab/_components/IntentCard/` (folder convention: `IntentCard.tsx`, `index.ts`,
  `constants.ts`, `styles.ts`, tests), rendered ABOVE the Description section. Per mockup:
  `SectionLabel` "INTENT" header, quoted italic summary, columns **IN SCOPE** (check
  bullets) / **OUT OF SCOPE** (x bullets, dimmed), **RISK AREAS** chip row. Badges:
  low-confidence, missing-context (lists `unavailable` source refs), stale
  (`head_sha` mismatch → "Re-classify" button). Empty state: "Classify intent" CTA;
  mutation `isPending` drives loading. Styles = `styles.ts` `CSSProperties` + `var(--…)`
  tokens, no Tailwind; strings via next-intl `brief` namespace (extend with `intent.*`).
- `page.tsx` passes `prId` + `headSha` into `OverviewTab`.

## 8. Observability

One structured pino line per classification:
`{ feature: 'intent', provider, model, promptSections: [{name, chars}], tokenEstimate,
sources: [{kind, ref, status}] }` — **never** source bodies, diff content, or secrets.
In review context the step runs under `RunLogger` (SSE + persisted `run_traces.log`);
scope-filter drops are emitted as run events. Tokens/cost come from `StructuredResult`
(OpenRouter returns real `usage.cost` — never recompute, per INSIGHTS).

## 9. Seed

`pr_intent` row for demo PR #482 in `db/seed.ts` matching the mockup: rate-limiting
summary, in/out scope lists, `risk_areas: ['Auth surface touched', 'New dependency:
ioredis', 'Adds Redis round-trip per request']`, `confidence: 'high'`, PR-description
source `fetched`, `head_sha` = seeded pull's head. Seeded `pr_files` carry no patches —
live re-classification on seed data degrades to title/body/paths by design.

## 10. Tests

- Server hermetic `test/intent-service.test.ts`: `MockLLMProvider` with
  `structuredBySchema.IntentClassification`; empty body → `low` confidence; missing repo
  doc (fake GitClient that THROWS — the shared mock returns `''`) → `unavailable` + low;
  linked issue fetched → `fetched` + high; external URL → `unavailable`, never fabricated;
  captured LLM messages contain hunk headers but no patch bodies; log object carries no
  source bodies.
- Server integration `test/intent.it.test.ts` (testcontainers): classify → persist → GET
  round-trip; re-classify upserts; `head_sha` change → `stale: true`; unique repo
  `fullName` per INSIGHTS.
- reviewer-core `test/scope.test.ts`: all-in-scope unchanged; non-critical out dropped
  with reasons; multiple CRITICAL out → exactly one kept (correct pick, rationale marker,
  `scope` stripped); plus `run.test.ts` (score recomputed post-scope; no-intent path
  byte-identical) and `prompt.test.ts` (intent section wrapped, guard intact).
- Client `IntentCard.test.tsx`: populated card (summary/columns/chips); empty → CTA →
  POST → renders result; low-confidence + stale badges + Re-classify flow.
- Contracts: parse fixtures for `IntentDetail`/`ScopedReview` in `contracts.test.ts`;
  routes added to `routes-smoke.test.ts`.

## 11. Risks & mitigations

- **Prompt injection** (PR body / issue / docs → classifier; derived intent → reviewer):
  untrusted-wrapping everywhere, trusted-side-only tagging instructions, `.max()` output
  caps, existing `INJECTION_GUARD` already covers derived intent/scope.
- **Intent as a silencer**: mechanically impossible — filter runs after grounding, one
  CRITICAL out-of-scope signal always survives, every drop is an event, score recomputed.
- **SSRF**: zero arbitrary HTTP in v1 (locked decision) — only Octokit + repo-local
  `git.readFile`.
- **Frozen-contract lockstep**: new shapes only in the new file, vendored ×2, verified by
  `diff -r` on touched contract files; `trace.ts` untouched.
- **Executor coupling**: intent is best-effort shared pre-work; failures degrade cleanly.
- **Env gotchas** (INSIGHTS): `npm ci` in `reviewer-core/` before any server step loading
  it; `npx pnpm@11` for adds inside `server/`; `pnpm arch` Node version constraint.

## 12. Verification (execution order)

1. `cd reviewer-core && npm ci && npm run typecheck && npm test`
2. `cd server && pnpm db:generate && pnpm db:migrate && pnpm db:seed`
3. `cd server && pnpm typecheck && pnpm test`
4. `cd server && pnpm arch` — 0 errors, no NEW warnings vs baseline
5. `cd client && pnpm typecheck && pnpm test`
6. Manual: `./scripts/dev.sh` → PR #482 Overview shows seeded IntentCard above
   Description; POST re-classify with an OpenRouter key; run a review → "Resolving PR
   intent" step + scope-drop events in the Live Log.
7. `diff -r` the touched files under `server/src/vendor/shared` vs
   `client/src/vendor/shared` — byte-identical.

## 13. Decisions

| Decision | Choice | Alternative kept cheap |
|---|---|---|
| External URL fetching | v1: mark `unavailable`, no fetch (SSRF) | `UrlFetcher` port + guarded adapter (follow-up) |
| "Severe" out-of-scope | `CRITICAL` only | widen predicate in `scope.ts` |
| Scope judgment | reviewer model tags per-finding `scope` (extended output schema) | path-matching vs free-text `in_scope[]` — rejected (unreliable) |
| Classification execution | sync POST (one cheap LLM call) | job + 202 + poll |
| Staleness | `head_sha` compare + manual Re-classify | auto re-classify on sync |
| Trace slot | none — intent visible inside `assembly.user` | `PromptAssembly.intent` (needs contracts-owner call) |
| Model routing | `resolveFeatureModel('review_intent')` | unused `model-router.ts` — deliberately ignored |

## 14. Out of scope / follow-ups

Guarded `UrlFetcher` adapter (https-only, private-IP deny, size cap, timeout); async/job
classification; intent history/versioning; non-English i18n; e2e coverage.
