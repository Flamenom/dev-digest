# @devdigest/mcp — local stdio MCP server for Claude Code

Thin HTTP proxy exposing DevDigest to Claude Code over MCP (stdio). Every tool
translates flat, human-friendly arguments (repo full name, PR **number**, agent
name) into the row **uuids** the Fastify API at `:3001` expects, calls the
existing REST endpoints, and returns a concise structured result. No DB access,
no DI duplication — the API stays the single backend.

## One-time setup

```bash
cd mcp && pnpm install
```

The project-scoped `.mcp.json` at the repo root spawns this server via
`mcp/node_modules/.bin/tsx`, so the install above must happen once before
Claude Code can start it. The DevDigest API must be running
(`./scripts/dev.sh` from the repo root).

## How to run

- Via Claude Code: open the repo, approve the project `.mcp.json` — Claude Code
  spawns the server on stdio automatically.
- Manually (smoke test): `cd mcp && pnpm dev` — startup banner goes to stderr;
  stdout is reserved for JSON-RPC framing (never write to it).
- Via MCP Inspector (separate web UI, no Claude Code involved) — see below.
- `pnpm typecheck` · `pnpm test` (hermetic vitest — fake API, fake timers).

Config: `DEVDIGEST_API_BASE` env (default `http://localhost:3001`).

## MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is a local
dev UI that speaks MCP: it spawns this server, lists its tools/resources and
lets you call any tool with hand-written arguments and read the raw JSON-RPC
response. Useful for debugging a tool without going through Claude Code.

```bash
cd mcp && pnpm inspect      # web UI → http://127.0.0.1:6274 (browser opens automatically)
```

The printed URL carries an `MCP_INSPECTOR_API_TOKEN` query param — open **that**
link, not bare `:6274`. Ports: `6274` UI, `6275` MCP-Apps sandbox.

Both scripts point the inspector at the repo-root `.mcp.json`, so it spawns the
server exactly the way Claude Code does — same command, args and
`DEVDIGEST_API_BASE`. There is no second copy of the server config to keep in
sync.

They also `cd ..` first, and that part is load-bearing: the paths in `.mcp.json`
are relative to the repo root, and the inspector's web backend **ignores its own
`--cwd` flag** for config-seeded stdio servers — it stamps `cwd: process.cwd()`
instead (`clients/web/build/index.js`, `ensureStdioCwd`). Run it from `mcp/` and
connecting fails with `spawn mcp/node_modules/.bin/tsx ENOENT`.

Headless variant for one-off calls / scripting:

```bash
pnpm inspect:cli --method tools/list
pnpm inspect:cli --method tools/call --tool-name devdigest_list_agents
pnpm inspect:cli --method tools/call --tool-name devdigest_get_findings \
  --tool-arg repo=Flamenom/dev-digest --tool-arg pr=2
```

The API at `:3001` must be running for any tool call to return real data.

## Tools

| Tool | Kind | Does |
|---|---|---|
| `devdigest_list_agents` | read | List configured review agents (id, name, model, enabled). |
| `devdigest_run_agent_on_pr` | write | Run one agent on a PR and wait (≤120 s); on timeout returns `run_id` + "fetch later" guidance. |
| `devdigest_get_findings` | read | Verdict, score and findings from completed review runs (filters: agent, severity; concise/detailed). |
| `devdigest_get_conventions` | read | Extracted repo coding conventions (status filter, default `all`). |
| `devdigest_get_blast_radius` | stub | Not implemented yet — returns `{ status: 'not_implemented' }`. |

## Package map

```
src/
  index.ts    — 5-line stdio bootstrap (the only transport wiring)
  server.ts   — composition root: buildServer(api) registers all 5 tools
  config.ts   — API_BASE + poll/timeout budgets
  api.ts      — the ONLY file doing fetch; DevDigestApi (get/post) + ApiError
  errors.ts   — toToolError: single mapper to isError results with forward-leading text
  resolve.ts  — repo / PR / agent → uuid resolvers (pure, injected DevDigestApi)
  mappers.ts  — own-zod output schemas + pure response mappers (concise/detailed)
  poll.ts     — waitForRun: poll GET /pulls/:id/runs until done/failed/timeout
  tools/      — one file per tool: presentation only (args ↔ one use case)
test/         — hermetic vitest suites (fake DevDigestApi, injected sleep,
                InMemoryTransport for the in-memory MCP integration test)
```

Contracts from `@devdigest/shared` are consumed **type-only** via a tsconfig
path alias to `../server/src/vendor/shared` (enforced by
`verbatimModuleSyntax`); all runtime Zod schemas are defined fresh with this
package's own zod — the vendored contracts are never imported at runtime.
