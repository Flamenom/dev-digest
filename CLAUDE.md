# DevDigest — project map for agents

Local-first AI pull-request review (course starter). 4 packages, **not** a
monorepo workspace: each has its own package.json + lockfile; cross-package code
is shared via **tsconfig path aliases**, not npm.

## Stack
- Node ≥22 · pnpm ≥10 · Docker (Postgres only)
- server `@devdigest/api` :3001 — Fastify 5 · Drizzle + postgres-js · Postgres+pgvector · Zod · tsx · vitest
- client `@devdigest/web` :3000 — Next.js 15 · React 19 · TanStack Query 5 · next-intl · Tailwind v4
- reviewer-core `@devdigest/reviewer-core` — pure TS review engine (no JS emit; build = typecheck)
- e2e `@devdigest/e2e` — deterministic browser e2e (agent-browser; no LLM)
- shared `@devdigest/shared` — Zod contracts, **vendored** at `server/src/vendor/shared`

## Commands
- `./scripts/dev.sh` — boot Postgres + API + web from zero (flags: --no-seed --db-only --no-client)
- per package: `pnpm dev | build | test | typecheck`
- server db: `pnpm db:migrate` (NOT auto-run on boot) · `pnpm db:seed` · `pnpm db:generate`
- server tests split by filename: `*.it.test.ts` = Postgres (testcontainers); rest = hermetic

## Where things are
- API modules → `server/src/modules/<name>/` (routes→service→repository); registered in `modules/index.ts`
- adapters (git/github/llm/astgrep/…) → `server/src/adapters/`; DI in `server/src/platform/container.ts`
- codebase indexer → `server/src/modules/repo-intel/`
- review engine → `reviewer-core/src/` (entry `review/run.ts`)
- UI routes → `client/src/app/`; API layer → `client/src/lib/{api.ts,hooks}`

## Non-default conventions (won't guess from code)
- `@devdigest/shared` is vendored, not installed; client keeps its OWN copy; reviewer-core reads server's copy.
- Modules registered **statically** (no filesystem autoload — .ts dynamic import isn't portable).
- Client styles = inline `styles.ts` + CSS tokens (`var(--…)`), NOT Tailwind classes.
- Client routes keyed by PR **number**; every API is keyed by row **uuid**.

## Do-not-touch
- `@devdigest/shared` contracts — EXTEND with new files; do NOT edit existing (breaks web↔api↔engine lockstep).
- reviewer-core purity — no DB/GitHub/FS; only the injected `LLMProvider`.
- grounding gate + deterministic re-score (`reviewer-core/src/grounding.ts`) — do not bypass.
- `server/src/db/migrations/*` — never edit applied SQL; add a new migration.
- `server/clones/` — runtime git clones, not source.

## Gotchas
- `relation ... does not exist` → migrations not applied: `cd server && pnpm db:migrate`.
- ZodError matched by **shape**, not `instanceof` (duplicate zod instances vendored vs api).
- Course markers `L0x / A1–A6 / T1–T3 / F1–F2` = future lesson steps, not legacy.

## Read when
- **`README.md`** — first, for the end-to-end flow and quick start.
- **`docs/architecture.md`** — when changing the review pipeline / repo-intel / cross-package wiring.
- **`server/CLAUDE.md` · `client/CLAUDE.md` · `reviewer-core/CLAUDE.md` · `e2e/CLAUDE.md`** — auto-load per folder; read before editing that package.
- **`INSIGHTS.md`** — before debugging a cross-cutting issue.
