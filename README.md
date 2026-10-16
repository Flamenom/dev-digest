# DevDigest

Local-first AI pull-request review. Import a PR, run one or more reviewer agents
on it, and get grounded, structured findings — plus the context around them
(intent, risk-ordered diff, blast radius, PR brief) and an eval harness that
tells you whether an agent change made reviews better or worse. Course lessons
L01–L06 are implemented on `main`; see [_Features_](#features) and
[_Roadmap_](#roadmap).

Several standalone packages (no monorepo workspace — each has its own
`package.json` and lockfile; cross-package code is shared through tsconfig path
aliases, not published modules):

| Folder           | Package                     | What it is                                            | Port |
|------------------|-----------------------------|-------------------------------------------------------|------|
| `server/`        | `@devdigest/api`            | Fastify API + Drizzle/Postgres (pgvector)             | 3001 |
| `client/`        | `@devdigest/web`            | Next.js 15 web app (the studio)                       | 3000 |
| `reviewer-core/` | `@devdigest/reviewer-core`  | Pure review engine: diff → prompt → LLM → findings    | —    |
| `e2e/`           | `@devdigest/e2e`            | Deterministic browser e2e (agent-browser)             | —    |
| `mcp/`           | `@devdigest/mcp`            | Local stdio MCP server for Claude Code (5 tools, HTTP proxy to the API) | — |
| `evals/`         | `@devdigest/evals`          | Harness evals for the Claude Code skills/agents/workflow (vitest + Claude Agent SDK) | — |
| `server/src/vendor/shared` | `@devdigest/shared` | Zod contracts shared across every package             | —    |

`repo-intel` (the codebase indexer that builds the repo map for
reviews and the import graph behind Blast Radius) lives inside the server at
[`server/src/modules/repo-intel`](server/src/modules/repo-intel). Only
**Postgres** runs in Docker; the API and web app run on the host via `pnpm dev`.

## Architecture

```mermaid
flowchart LR
  subgraph Studio["Local studio (your machine)"]
    WEB["client/<br/>Next.js · :3000"]
    API["server/<br/>Fastify · :3001"]
    PG[("Postgres<br/>pgvector")]
    WEB -->|"REST /repos /pulls /agents /runs /evals …"| API
    API --> PG
  end

  CC["Claude Code"] -->|"stdio"| MCP["mcp/<br/>5 tools"]
  MCP -->|"REST"| API
  GH["GitHub"]
  API -->|"PR sync"| GH

  CLONE["git clone (add repo)"] --> INDEX["repo-intel<br/>index symbols + import graph<br/>→ repo map"]
  API --> CLONE
  INDEX -->|"repo map = review context"| ENGINE

  ENGINE["reviewer-core/<br/>diff + repo map → prompt → LLM<br/>→ structured findings → grounding gate"]
  LLM["LLM<br/>OpenAI · Anthropic · OpenRouter"]
  API -->|"run review / run eval case"| ENGINE
  ENGINE --> LLM

  SHARED["@devdigest/shared<br/>Zod contracts"]
  SHARED -.->|"one schema, every package"| WEB
  SHARED -.-> API
  SHARED -.-> ENGINE
```

The review flow end to end: **add a repo** → server clones it and `repo-intel`
indexes it → **import PRs** from GitHub → open a PR and
**Review** → `reviewer-core` assembles a prompt from the diff + the repo map,
calls the LLM, validates every finding against the diff (the **grounding gate**
drops hallucinated line references), and persists structured findings with a
severity and score. All local; the only outbound calls are to GitHub (PR data)
and the LLM (via OpenRouter).

The PR list stays fresh on its own: `GET /repos/:id/pulls` syncs open PRs from
GitHub on every read when a token is configured (falling back to the persisted
rows offline), and the web app refetches it every 60s and on window focus.

Each package has its own README with deeper diagrams:
[`client`](client/README.md) (UI route map) ·
[`server`](server/README.md) (API map) ·
[`reviewer-core`](reviewer-core/README.md) (review pipeline) ·
[`e2e`](e2e/README.md) ·
[`mcp`](mcp/README.md) ·
[`evals`](evals/README.md).

## Features

Base flow — **local launch** (one command), **Settings** (LLM key + GitHub
token), **add repository** (clone + index), **import PRs** (diff, commits, body,
linked issue), GitHub-like **diff view**, **agents** (five seeded reviewers —
General, Security, Performance, Test Quality, API Contract; create/edit your own: model + system prompt + skills), and
**run a review** (structured findings with severity + score, grounding gate,
repo-map context). Each run has a **trace drawer** (prompt assembly, raw output,
live log).

| Lesson | Feature | What it does | Where in the UI | Spec |
|--------|---------|--------------|-----------------|------|
| L01 | Run cost badge | USD cost of a run, rolled up per PR | PR list (cost column) · run history | — |
| L01 | Finding counters | Per-severity finding chips for each agent's latest review, hover card lists the findings | PR list (FINDINGS column) | — |
| L02 | Skills Lab | Reusable markdown rule blocks, versioned, linked to agents and appended to their prompt | `/skills` · agent editor → Skills tab | [`02-skills-lab`](specs/02-skills-lab.md) |
| L02 | Conventions Extractor | Extracts candidate house-rules from the repo, drops ungrounded ones, merges accepted ones into a skill | `/conventions` | [`03-conventions-extractor`](specs/03-conventions-extractor.md) |
| L03 | Intent Layer | Classifies why the PR exists (in/out of scope), injects it into the review prompt, filters out-of-scope findings | PR → Overview → Intent card | [`04-intent-layer`](specs/04-intent-layer.md) |
| L03 | Smart Diff | Deterministic (no-LLM) risk ordering of files into core / wiring / boilerplate, findings inline | PR → Files changed → Smart order | [`05-smart-diff`](specs/05-smart-diff.md) |
| L04 | MCP server | 5 Claude Code tools (list agents, run agent on PR, get findings, conventions, blast radius) via root `.mcp.json` | Claude Code | [`l04-mcp-server`](docs/plans/l04-mcp-server.md) |
| L04 | Blast Radius | Changed symbols → callers → endpoints/crons + prior PRs, from the `repo-intel` index (no LLM) | PR → Overview → Blast card | [`l04-blast-radius`](docs/plans/l04-blast-radius.md) |
| L05 | Project Context | Attach `specs/` / `docs/` / `insights/` markdown from the clone to an agent; injected as untrusted context on every run | `/repos/:repoId/project-context` · agent editor → Context tab | [`project-context`](specs/2026-08-27-project-context.md) |
| L05 | PR Brief | Why + risk brief for the PR (cached), Risk Areas and a Review Focus block | PR → Overview → PR Brief card | [`pr-brief`](specs/2026-08-27-pr-brief.md) |
| L06 | Eval Pipeline | In-app regression harness for reviewer agents: accepted findings become `must_find` cases, dismissed ones `must_not_flag`; cases run through the real engine, scored by code | Finding → "Turn into eval case" · `/evals` · `/evals/:agentId` · agent editor → Evals tab | [`06-eval-pipeline`](specs/06-eval-pipeline.md) |

**Two different "evals".** The **Eval Pipeline** above is a product feature
(server `modules/eval`, Postgres, Eval Dashboard) that evaluates the in-app
reviewer agents. The [`evals/`](evals/README.md) package is unrelated
developer tooling: it evaluates this repo's **Claude Code harness**
(`.claude/skills`, `.claude/agents`, `CLAUDE.md`) with vitest + the Claude Agent
SDK, and runs in CI via `harness-evals.yml`.

## Roadmap

Not implemented yet — later course lessons:

| Lesson | Planned |
|--------|---------|
| L05 | Onboarding generator |
| L06 | Secret / Phantom-API gates · Export to CI |
| L07 | Multi-agent review · Persistent memory · per-agent stats |
| L08 | Plugin export/import · Agent performance dashboard · weekly digest |

## Prerequisites

- **Node** ≥ 22 · **pnpm** ≥ 10 (`npm i -g pnpm`) · **Docker** (for Postgres)

## Quick start (from zero)

```sh
./scripts/dev.sh
```

This script:
1. starts Postgres (`docker compose up -d`) and waits until it's healthy,
2. creates `server/.env` and `client/.env` from `.env.example` if missing,
3. installs deps in `server/`, `client/` (pnpm) and `reviewer-core/` (npm) — only when `node_modules` is absent,
4. applies DB migrations and seeds demo data,
5. launches the API (`:3001`) and the web app (`:3000`).

Open **http://localhost:3000**. Press **Ctrl-C** to stop the dev servers —
Postgres keeps running (`docker compose down` to stop it).

Flags: `--no-seed` · `--no-client` · `--db-only` · `--help`.

> Add your keys in `server/.env` (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`,
> `GITHUB_TOKEN`) or via the Settings UI at runtime.

## Manual steps (what the script does)

```sh
docker compose up -d                                   # Postgres + pgvector

cd server && pnpm install
pnpm db:migrate          # apply migrations (NOT run automatically on boot)
pnpm db:seed             # idempotent demo data (optional)
pnpm dev                 # API on :3001

cd ../client && pnpm install && pnpm dev               # web on :3000
```

Optional: `cd mcp && pnpm install` once to let Claude Code spawn the MCP server
from the root `.mcp.json`; `cd evals && pnpm install` to run the harness evals.

## Useful scripts

`server/`: `dev` · `build` · `db:migrate` · `db:seed` · `db:generate` · `test` · `typecheck` · `verify:l03` · `verify:l06`
(unit/integration split: `pnpm exec vitest run --exclude '**/*.it.test.ts'` / `pnpm exec vitest run .it.test`)
`client/`: `dev` · `build` · `start` · `test` · `typecheck`
`mcp/`: `dev` · `inspect` (MCP Inspector) · `test` · `typecheck`
`evals/`: `eval` · `eval:skills` · `eval:agents` · `eval:workflow` · … (see [`evals/README.md`](evals/README.md))

## Testing & CI

One test suite per package, each gated by its own GitHub Actions workflow with a
path filter — full strategy in **[`TESTING.md`](TESTING.md)**.

| Suite | Workflow | Needs Docker |
|-------|----------|--------------|
| client (vitest + jsdom) | `client.yml` | no |
| server unit (hermetic) + `verify:l06` eval gate | `server-unit.yml` | no |
| server integration (real Postgres) | `server-integration.yml` | yes |
| reviewer-core (engine) | `reviewer-core.yml` | no |
| web e2e (agent-browser, real stack) | `e2e-web.yml` | yes |
| harness evals (`evals/`, on `.claude/**` / `CLAUDE.md` changes) | `harness-evals.yml` | no |
| `@devdigest/shared` copies identical (`node scripts/check-shared-sync.mjs`) | `shared-sync.yml` | no |

Server tests split by filename: `*.it.test.ts` are DB-backed (testcontainers
Postgres); everything else is hermetic. The browser e2e flows live in
[`e2e/`](e2e/README.md) and run deterministically (no LLM).

## Troubleshooting

- **`relation ... does not exist` / API errors on first run** — migrations weren't
  applied. The server does **not** migrate on boot: run `cd server && pnpm db:migrate`.
- **Port 5432 already in use** — another Postgres is running. Stop it, or change the
  host port in `docker-compose.yml`.
- **`vector` type errors** — the pgvector extension is enabled by migration `0000`;
  make sure migrations ran against the Dockerized DB, not a different one.
- **Reset everything** — `docker compose down -v` drops the volume, then re-run
  `./scripts/dev.sh`.
