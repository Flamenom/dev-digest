# Insights — @devdigest/web

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here

## What Doesn't Work — antipatterns & mistakes

- A hover/popover rendered inside the PR-list table with `position:absolute` gets CLIPPED — the table wrapper `s.tableCard` sets `overflow:hidden` (styles.ts:86). Render the floating panel with `position:fixed` + coords from the trigger's `getBoundingClientRect()` (no transformed ancestor exists, so `fixed` escapes the clip and isn't bound by the row). Clamp `left` to the viewport. Evidence: client/src/components/FindingsHoverCard/styles.ts (panel()); client/src/app/repos/[repoId]/pulls/styles.ts:86. Confidence: high. (2026-08-01)

## Codebase Patterns & Tool/Library Notes

- Timeline runs (`RunSummary`, trace.ts) carry only scalar `findings_count` + `blockers` — NO per-severity breakdown. To show CRITICAL/WARNING/SUGGESTION per run, join `run_id` → `ReviewRecord.findings` from the already-loaded `usePrReviews` payload in FindingsTab (build `Map<run_id, findings>`, pass to RunHistory as `findingsByRun`); don't add server fields. Errored/review-less runs won't join → keep the flat `findings_count` fallback. Evidence: client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx; _components/RunHistory/RunHistory.tsx. Confidence: high. (2026-08-01)

- PR-list table columns are data-driven: `GRID` (grid-template-columns) + `COLUMN_KEYS` in pulls/constants.ts drive BOTH the header (page.tsx maps COLUMN_KEYS) and the rows (PRRow) — they must stay in sync. Adding a column = one GRID track + a COLUMN_KEYS entry + an i18n key (messages/en/prReview.json `list.columns`) + a cell in PRRow. Cross-feature shared bits (e.g. RunCostBadge) live under pulls/_components/ and are imported by deep detail components (RunHistory, TraceBody) via relative paths. Evidence: client/src/app/repos/[repoId]/pulls/constants.ts:27,42; _components/PRRow/PRRow.tsx. Confidence: high. (2026-07-31)

## Decisions — with the why

## Recurring Errors & Fixes

## Open Questions
