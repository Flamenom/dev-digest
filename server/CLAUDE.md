# @devdigest/api — Fastify server map

Studio backend: runs AI reviews on GitHub PRs, backed by the repo-intel indexer. :3001

## Local commands
- `pnpm dev` (tsx watch) · `pnpm db:migrate` before first run · `pnpm db:seed`
- tests split by filename: `*.it.test.ts` = Postgres (testcontainers); rest = hermetic

## Where things are
- feature modules: `src/modules/<name>/` = routes → service → repository
- static module registry: `src/modules/index.ts` (add a module here)
- DI composition root: `src/platform/container.ts` (lazy adapter getters)
- external ports: `src/adapters/*` behind `@devdigest/shared` interfaces
- DB: `src/db/schema/*` (barrel `schema.ts`) · migrations `src/db/migrations/*`
- SSE/jobs: `src/platform/{sse,jobs,run-logger}.ts`
- indexer: `src/modules/repo-intel/` (see its own README)

## Conventions (non-default)
- Cross-module entities go through the container (`container.agentsRepo`, `.repoIntel`), never sibling folders.
- Every domain table carries `workspace_id`; resolve tenancy via `modules/_shared` `getContext()`.
- Reviews run fire-and-forget: runId minted sync so client can SSE-subscribe; trace saved as ONE `run_traces` doc.
- OpenRouter provider lives in reviewer-core (not `adapters/llm`); PriceBook injects live pricing.

## Do-not-touch
- pgvector columns are 1536-dim (match `OpenAIEmbedder`); embeddings gated by `EMBEDDINGS_ENABLED`.
- `src/db/migrations/*` — never edit applied SQL; add a new migration via `pnpm db:generate`.
- Stale-run reaping on boot assumes a single API instance per DB.
- `clones/` — runtime git clones, not source.

## Read when
- **`README.md`** — API map + full module/route list.
- **`src/modules/repo-intel/README.md`** — when touching indexing or review context.
- **`../reviewer-core/README.md`** — when changing how a review is executed.
- **`../docs/architecture.md`** — for cross-package wiring and the review flow.
- **`INSIGHTS.md`** — before debugging runs/SSE/migrations/tenancy; read at session start, and capture substantial learnings at the end via `/engineering-insights` (insert-only).
- **`specs/*.md`** — when implementing a lesson module (skills, intent, blast, eval…).
