# Insights — @devdigest/api

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here

## What Doesn't Work — antipatterns & mistakes

## Codebase Patterns & Tool/Library Notes

- The PR-list DTO (`GET /repos/:id/pulls`) is assembled in-handler with per-PR aggregates computed on READ via one IN-query + JS grouping (no FK denorm): latest-review SCORE from `reviews`, and total COST summed across the PR's `agent_runs`. `reviews.run_id` has NO FK to `agent_runs`. Add new list columns here, not in a repository. Evidence: server/src/modules/pulls/routes.ts:114-165. Confidence: high. (2026-07-31)
- `pnpm db:seed` creates a review (score 61) but NO agent_runs and no `reviews.run_id` — so run-level UIs (cost column, timeline, trace drawer) are empty on a fresh seed until a live review runs. The trace drawer additionally needs a `run_traces` doc (getRunTrace casts the jsonb, no zod parse). To demo run-level UIs offline, seed sample `agent_runs` + a `run_traces` row and link the review's run_id. Evidence: server/src/db/seed.ts (demo-runs block); server/src/modules/reviews/repository/run.repo.ts:183. Confidence: high. (2026-07-31)

## Decisions — with the why

- PR-list per-PR rollups (SCORE, FINDINGS) must aggregate across AGENTS, not pick "the latest review". A PR is typically reviewed by several agents at once, creating multiple `reviews` rows with the SAME `createdAt` — so `ORDER BY createdAt DESC` + first-seen returns an ARBITRARY agent (symptom: list showed score 100 / 0 findings while another agent had a blocker). Fix: take the latest review per `(prId, agentId)` (a re-run replaces, never double-counts), then SUM findings severities and take the MIN (worst) score across agents. Evidence: server/src/modules/pulls/routes.ts:114-176. Confidence: high. (2026-08-01)

## Recurring Errors & Fixes

## Open Questions
