# Insights — DevDigest (cross-cutting)

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here

## What Doesn't Work — antipatterns & mistakes

## Codebase Patterns & Tool/Library Notes

- `@devdigest/shared` contracts are vendored TWICE (server/src/vendor/shared, client/src/vendor/shared) — edit both in lockstep. A zod `.nullable()` field is required-but-null (the KEY must be present), so adding one (e.g. `RunStats.cost_usd`) breaks every fixture that builds the object (server/test/contracts.test.ts RunTrace.parse; client RunHistory/RunTraceDrawer test fixtures). Use `.nullish()` for a genuinely optional / list-only field like `PrMeta.cost_usd`. Evidence: server/src/vendor/shared/contracts/trace.ts:60, platform.ts:157. Confidence: high. (2026-07-31)
- Per-run LLM cost is already computed at runtime — never recompute it to re-surface it. reviewer-core's review outcome carries `costUsd` (OpenRouter `usage.cost`, else `estimateCost`/PriceBook fallback); the course "remove cost" commits (d45ab0d, 58c6ac7) stripped only server-persist + client-display, so re-adding is pure re-threading with zero extra model calls. Evidence: reviewer-core/src/review/run.ts:110,216; reviewer-core/src/llm/openrouter.ts:94-107. Confidence: high. (2026-07-31)

## Decisions — with the why

## Recurring Errors & Fixes

- `ERR_MODULE_NOT_FOUND: Cannot find package 'openai' imported from reviewer-core/src/...` during `pnpm db:seed`, API boot, or server tests = reviewer-core deps not installed. reviewer-core is consumed as RAW source via a tsconfig alias, and its runtime deps (openai/zod) resolve from `reviewer-core/node_modules` — a SIBLING of `server/`, NOT an ancestor — so `server`'s own `openai` install can't satisfy them. Any step that loads reviewer-core must run `npm ci` in `reviewer-core/` FIRST (reviewer-core uses npm, not pnpm). Was ordered AFTER `db:seed` in e2e-web.yml → crash. Evidence: .github/workflows/e2e-web.yml (Install reviewer-core deps); server-integration.yml:56. Confidence: high. (2026-08-01)

## Open Questions
