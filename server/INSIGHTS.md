# Insights — @devdigest/api

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here

## What Doesn't Work — antipatterns & mistakes

## Codebase Patterns & Tool/Library Notes

- `MockGitClient.readFile` returns `''` for missing files instead of throwing — code whose semantics are "throw ⇒ file absent" (e.g. the conventions config probe) must inject a custom fake GitClient in tests, or every probed path counts as present. Evidence: server/src/adapters/mocks.ts:293-294; server/test/conventions.it.test.ts:41-47. Confidence: high. (2026-08-19)

- The PR-list DTO (`GET /repos/:id/pulls`) is assembled in-handler with per-PR aggregates computed on READ via one IN-query + JS grouping (no FK denorm): latest-review SCORE from `reviews`, and total COST summed across the PR's `agent_runs`. `reviews.run_id` has NO FK to `agent_runs`. Add new list columns here, not in a repository. Evidence: server/src/modules/pulls/routes.ts:114-165. Confidence: high. (2026-07-31)
- `pnpm db:seed` creates a review (score 61) but NO agent_runs and no `reviews.run_id` — so run-level UIs (cost column, timeline, trace drawer) are empty on a fresh seed until a live review runs. The trace drawer additionally needs a `run_traces` doc (getRunTrace casts the jsonb, no zod parse). To demo run-level UIs offline, seed sample `agent_runs` + a `run_traces` row and link the review's run_id. Evidence: server/src/db/seed.ts (demo-runs block); server/src/modules/reviews/repository/run.repo.ts:183. Confidence: high. (2026-07-31)

## Decisions — with the why

- PR-list per-PR rollups (SCORE, FINDINGS) must aggregate across AGENTS, not pick "the latest review". A PR is typically reviewed by several agents at once, creating multiple `reviews` rows with the SAME `createdAt` — so `ORDER BY createdAt DESC` + first-seen returns an ARBITRARY agent (symptom: list showed score 100 / 0 findings while another agent had a blocker). Fix: take the latest review per `(prId, agentId)` (a re-run replaces, never double-counts), then SUM findings severities and take the MIN (worst) score across agents. Evidence: server/src/modules/pulls/routes.ts:114-176. Confidence: high. (2026-08-01)

## Recurring Errors & Fixes

- `pnpm arch` fails with "Your node version (23.x) is not supported" — dependency-cruiser only runs on `^20.12||^22||>=24`. Fix: run under an installed nvm Node 22, e.g. `PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" pnpm arch`. Evidence: server/.dependency-cruiser.cjs; `~/.nvm/versions/node/`. Confidence: high. (2026-08-19)
- It-tests that insert their own repo hit `repos_ws_fullname_uq` if they reuse a seeded full_name — `seed()` already creates `acme/payments-api` in the default workspace. Use a unique `fullName` per test file (or a `repoSeq` counter like pulls-comments.it.test.ts:24). Evidence: server/src/db/seed.ts; server/test/conventions.it.test.ts:78. Confidence: high. (2026-08-19)

## Open Questions
