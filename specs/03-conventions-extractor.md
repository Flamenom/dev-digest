# 03 — Conventions Extractor (L02): repo house-rules → skill

Status: **implemented** (2026-08-19). Cross-package (server + client + shared contracts);
reviewer-core needs **no changes** — its grounding gate is mirrored server-side, not extended.

The extractor scans the active repo's clone, asks the per-workspace `conventions` feature
model for candidate house-rules, **grounds** every candidate's evidence against the exact
file contents the model saw (ungrounded candidates are dropped, never shown), and lets the
user accept/reject/edit candidates before merging the accepted ones into one editable
skill (`source: 'extracted'`, `type: 'convention'`) via the normal skills module (L02).
Linking the skill to an agent stays manual (Agents → Skills tab).

---

## 1. Pre-existing scaffolding (reused, not rebuilt)

| Piece | Where |
|---|---|
| `conventions` table (id, ws, repo, rule, evidence path/snippet, confidence, `accepted` bool) | `server/src/db/schema/knowledge.ts`, migration `0000` |
| Frozen contract `ConventionCandidate` | `*/vendor/shared/contracts/knowledge.ts` — untouched |
| `RepoIntel.getConventionSamples(repoId, n)` — top-N ranked files (configs excluded by `isJunkPath`) | `server/src/modules/repo-intel/service.ts` |
| Feature model `'conventions'` + `resolveFeatureModel` | `contracts/platform.ts`, `server/src/modules/settings/feature-models.ts` |
| `MockLLMProvider.structuredBySchema` keyed on `ConventionFileSelection` / `ConventionExtraction` | `server/src/adapters/mocks.ts` |
| `skills.evidence_files` jsonb + `Skill.evidence_files` DTO | `server/src/db/schema/skills.ts`, `skills/helpers.ts` |
| i18n namespace + nav active-key mapping for `/conventions` | `client/messages/en/conventions.json`, `app-shell/helpers.ts` |

## 2. Contracts (new file, vendored ×2 byte-identical)

`*/vendor/shared/contracts/conventions.ts` + barrel line in both `index.ts`:
`ConventionCategory` (9 values), `ConventionStatus` (`pending|accepted|rejected`),
`Convention` (adds category, status, 1-based `evidence_start_line`/`end_line` nullish,
`created_at`), `ConventionScanStats` (`sampledFileCount`, `droppedCount`, `lastScanAt`),
`ConventionListResponse` (stats nullish before first scan), `ConventionExtractResponse`,
`UpdateConventionBody` (status and/or rule), `BulkConventionStatusBody`.

## 3. DB delta (migration `0013`)

- `conventions` + `category` (text enum, default `other`), `status` (text enum, default
  `pending`), `evidence_start_line`/`evidence_end_line` int, `created_at`, repo/ws indexes.
  Backfill: `status='accepted'` where `accepted=true`. **Invariant** (service-maintained):
  `accepted === (status === 'accepted')` — the boolean survives for the frozen contract.
- New `conventions_scans` — ONE row per repo (`repo_id` unique, upsert):
  `sampled_file_count`, `dropped_count`, `scanned_at`. A scan whose candidates were all
  dropped or later replaced still renders "Detected from N sample files · last scan X ago".

## 4. Server module `modules/conventions/`

`constants` · `prompts` · `grounding` · `helpers` · `repository` · `service` · `routes`;
registered in `modules/index.ts`. Cross-module rules: repos read directly from `t.repos`
(ws-scoped, pulls precedent), repo-intel via `container.repoIntel`, git via
`container.git`, LLM via `container.llm(provider)` — never a sibling module import.

Extraction pipeline (synchronous in the request — 2 LLM calls; all logic in
`ConventionsService.extract()` so a later job wrap is routes-only):

1. repo lookup (ws-scoped) → 404; `getConventionSamples(repoId, 40)` → empty ⇒ 422
   "not indexed".
2. Config probe: `git.readFile` over `CONFIG_FILE_CANDIDATES` (package.json, tsconfig,
   eslint/prettier/biome, .editorconfig, pyproject/go.mod/Cargo.toml; cap 8) — configs are
   excluded from ranked sampling by design, probed directly instead.
3. `resolveFeatureModel(ws, 'conventions')` → provider+model.
4. Step 1 `ConventionFileSelection`: model picks ≤12 pool files. Server intersects the
   answer with the offered set (hallucinated/traversal paths silently dropped; empty ⇒
   first-12 fallback), reads the survivors.
5. Step 2 `ConventionExtraction`: ≤15 candidates {category, rule, evidence_path,
   evidence_snippet, confidence} over `<untrusted>`-wrapped file blocks (per-file 8k char
   cap). Both steps: `completeStructured` (strict schema + repair), module-local
   `INJECTION_GUARD`/`wrapUntrusted` mirroring reviewer-core's.
6. `groundConventions(candidates, files)` — keep-or-drop-with-reason
   (`path-not-sampled` / `snippet-not-found` / `empty-snippet`); exact substring match
   resolves 1-based lines, whitespace-tolerant per-line fallback otherwise.
7. Persist: `replaceForRepo` (delete repo's rows + insert kept as `pending`, one tx) +
   `upsertScan`. **Re-scan = full replace** — accepted rules live on in created skills.

Routes: `GET /repos/:id/conventions` → list+stats · `POST /repos/:id/conventions/extract`
→ 200 sync · `PATCH /repos/:id/conventions` `{status}` → bulk (powers "Deselect all") ·
`PATCH /conventions/:id` `{status?, rule?}` → accept/reject/edit.

Skills pass-through: `POST /skills` now accepts optional `evidence_files: string[]`
(threaded routes → service → repository into the reserved jsonb column).

## 5. Client

- Nav: `SKILLS LAB → Conventions` (`ListChecks`, `/conventions`, `g c`) in
  `vendor/ui/nav.ts` + SHORTCUTS row; palette/shell derive automatically.
- Hooks `lib/hooks/conventions.ts`, key `["conventions", repoId]`: `useConventions`,
  `useExtractConventions` (isPending = "Scanning…", onSuccess `setQueryData`),
  `useUpdateConvention` + `useBulkConventionStatus` (optimistic patch + rollback).
  `CreateSkillInput` gained `evidence_files?`.
- `/conventions` page (flat URL, repo from `useActiveRepo()`):
  `ConventionsView` (states: no-repo / skeletons / error / empty-CTA / populated with
  scan meta + dropped note, Deselect all, "N of M accepted", Re-scan, Create skill) →
  `ConventionCard` (category badge, inline-editable rule, `SnippetBlock` evidence with
  copy, 0-100 ProgressBar confidence, Accept/Reject toggling through `pending`; rejected
  = 0.6 opacity + strikethrough) → `CreateSkillModal` (prefilled name
  `<repo>-conventions`, description, type `convention`, enabled toggle, `BodyEditor`
  reused from skills with the generated markdown; saves `source:'extracted'` + deduped
  `evidence_files`, then routes to `/skills/:id`).
- `generateSkillBody`: `# <repo>-conventions` header, intro ("Flag changes that violate
  any rule below and cite the offending `file:line`."), one `## <slug>` section per
  accepted convention with the rule, `Detected in \`path:lines\`:` and a fenced snippet
  (4-backtick fence when the snippet contains ```).

## 6. Tests

- Server hermetic: `test/conventions-grounding.test.ts` (line resolution, drop reasons),
  `test/conventions-service.test.ts` (2-step dialogue via `structuredBySchema`, config
  probing, hallucinated-path filtering, persistence wiring).
- Server integration: `test/conventions.it.test.ts` (extract→persist→list, dual-write
  invariant, re-scan replace, scan upsert, 404/422, `evidence_files` roundtrip, repo
  cascade).
- Client: `helpers.test.ts` (body generator), `ConventionCard/CreateSkillModal/
  ConventionsView` tests (mocked hooks, next-intl provider).

## 7. Decisions

| Decision | Choice | Alternative kept cheap |
|---|---|---|
| Extraction execution | sync POST (2 LLM calls) | job+202+poll — wrap `extract()` in a handler |
| Re-scan | replace all rows | keep-accepted → flag on `replaceForRepo` |
| Agent linking | manual via Agents → Skills tab | agent select in the modal |
| `accepted` bool | kept + dual-write with `status` | — (frozen contract) |
| Scan meta | `conventions_scans` upsert row | stats jsonb — rejected (empty-scan visibility) |
| Skill body generation | client-side pure helper | server draft endpoint |
