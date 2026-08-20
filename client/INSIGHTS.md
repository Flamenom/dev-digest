# Insights — @devdigest/web

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here

## What Doesn't Work — antipatterns & mistakes

- Nested dialogs (Modal opened from inside RunTraceDrawer's Drawer, e.g. PromptBlock) each add a `document`-level keydown listener — `stopPropagation()` does NOT stop other listeners on the same node, so one Escape closed every open layer, and per-dialog saved `body.overflow` re-locked scroll on close (sibling cleanup order runs the inner dialog's cleanup last, restoring its saved "hidden"). Fix: module-level dialog stack — only the topmost dialog handles Escape/Tab; the FIRST dialog saves body overflow, the LAST restores it. Evidence: client/src/vendor/ui/kit/dialog-behavior.ts (dialogStack, savedBodyOverflow); Modal.test.tsx (nested-Escape + scroll-lock tests). Confidence: high. (2026-08-18)

- A hover/popover rendered inside the PR-list table with `position:absolute` gets CLIPPED — the table wrapper `s.tableCard` sets `overflow:hidden` (styles.ts:86). Render the floating panel with `position:fixed` + coords from the trigger's `getBoundingClientRect()` (no transformed ancestor exists, so `fixed` escapes the clip and isn't bound by the row). Clamp `left` to the viewport. Evidence: client/src/components/FindingsHoverCard/styles.ts (panel()); client/src/app/repos/[repoId]/pulls/styles.ts:86. Confidence: high. (2026-08-01)

## Codebase Patterns & Tool/Library Notes

- Timeline runs (`RunSummary`, trace.ts) carry only scalar `findings_count` + `blockers` — NO per-severity breakdown. To show CRITICAL/WARNING/SUGGESTION per run, join `run_id` → `ReviewRecord.findings` from the already-loaded `usePrReviews` payload in FindingsTab (build `Map<run_id, findings>`, pass to RunHistory as `findingsByRun`); don't add server fields. Errored/review-less runs won't join → keep the flat `findings_count` fallback. Evidence: client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx; _components/RunHistory/RunHistory.tsx. Confidence: high. (2026-08-01)

- PR-list table columns are data-driven: `GRID` (grid-template-columns) + `COLUMN_KEYS` in pulls/constants.ts drive BOTH the header (page.tsx maps COLUMN_KEYS) and the rows (PRRow) — they must stay in sync. Adding a column = one GRID track + a COLUMN_KEYS entry + an i18n key (messages/en/prReview.json `list.columns`) + a cell in PRRow. Cross-feature shared bits (e.g. RunCostBadge) live under pulls/_components/ and are imported by deep detail components (RunHistory, TraceBody) via relative paths. Evidence: client/src/app/repos/[repoId]/pulls/constants.ts:27,42; _components/PRRow/PRRow.tsx. Confidence: high. (2026-07-31)

## Decisions — with the why

## Recurring Errors & Fixes

- Running `pnpm build` while `next dev` is up corrupts the shared `client/.next` for BOTH servers: dev starts 500ing and `next start` dies with `Cannot find module './vendor-chunks/recharts.js'` (or `./NNN.js`) from `.next/server/webpack-runtime.js`. Fix: stop the dev server FIRST (kill by port — `kill $(lsof -t -iTCP:3000 -sTCP:LISTEN)`; `pkill -f` can miss the detached node process), `rm -rf .next`, rebuild. Evidence: client/.next/server/webpack-runtime.js require-stack in the `next start` log. Confidence: high. (2026-08-18)

## Open Questions
