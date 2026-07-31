# Insights — @devdigest/web

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here

## What Doesn't Work — antipatterns & mistakes

## Codebase Patterns & Tool/Library Notes

- PR-list table columns are data-driven: `GRID` (grid-template-columns) + `COLUMN_KEYS` in pulls/constants.ts drive BOTH the header (page.tsx maps COLUMN_KEYS) and the rows (PRRow) — they must stay in sync. Adding a column = one GRID track + a COLUMN_KEYS entry + an i18n key (messages/en/prReview.json `list.columns`) + a cell in PRRow. Cross-feature shared bits (e.g. RunCostBadge) live under pulls/_components/ and are imported by deep detail components (RunHistory, TraceBody) via relative paths. Evidence: client/src/app/repos/[repoId]/pulls/constants.ts:27,42; _components/PRRow/PRRow.tsx. Confidence: high. (2026-07-31)

## Decisions — with the why

## Recurring Errors & Fixes

## Open Questions
