# @devdigest/reviewer-core — review engine map

Pure engine: diff → prompt → LLM → grounded findings. No DB/GitHub/FS; only an injected LLMProvider.

## Local commands
- `npm test` (vitest, stubbed LLMProvider — no keys/network)
- `npm run typecheck` (doubles as the build; emits no JS)

## Where things are
- entry: `src/review/run.ts` (`reviewPullRequest`)
- prompt assembly + injection hardening: `src/prompt.ts`
- grounding gate: `src/grounding.ts`
- structured output (Zod→JSON Schema, parse-with-repair): `src/llm/structured.ts`
- the one concrete provider (shared with CI): `src/llm/openrouter.ts`
- map-reduce + scoring: `src/review/reduce.ts` · CI payload: `src/output/to-review.ts`
- public API barrel: `src/index.ts`

## Conventions (non-default)
- Contracts (`Review`, `Finding`, `UnifiedDiff`, `LLMProvider`) come from `@devdigest/shared` (server's copy via alias).
- Skills/memory/specs arrive as ALREADY-resolved strings — the engine never does DB/fs lookups.
- Progress/cancel are injected callbacks (`onEvent`, `checkCancelled`) — no SSE/error-type coupling.

## Do-not-touch (invariants)
- Purity: the ONLY side effect is `llm.completeStructured`. Do not add DB/GitHub/FS/network.
- Grounding gate: findings must cite a real diff line or be dropped — don't relax it.
- Score is recomputed deterministically from surviving findings — never trust the model's number.

## Read when
- **`README.md`** — the pipeline diagram + public API list.
- **`../server/src/vendor/shared/contracts/findings.ts`** — the Finding/Review contracts you must satisfy.
- **`../docs/architecture.md`** — how the server drives the engine.
- **`INSIGHTS.md`** — before changing prompt assembly or provider retry logic; read at session start, and capture substantial learnings at the end via `/engineering-insights` (insert-only).
- **`specs/*.md`** — when implementing a lesson feature (map-reduce, memory slots, CI export…).
