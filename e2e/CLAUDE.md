# @devdigest/e2e — browser e2e map

Deterministic UI flows via Vercel agent-browser (Rust+CDP CLI). No Playwright, no LLM, no API key.

## Local commands
- `./scripts/e2e.sh` — hermetic: isolated seeded stack on :5433/:3101/:3100, SAFE alongside dev (preferred)
- `cd e2e && npm test` — ONLY if your dev DB has just the seeded repo
- one-time: `npm i -g agent-browser && agent-browser install`

## Where things are
- flows: `specs/NN-name.flow.json` — JSON lists of agent-browser commands. NOTE: these are FLOW specs, not lesson specs.
- runner: `run.ts` (runs steps in order against one shared session) · asserts: `lib/assert.ts`
- failure screenshots: `test-results/` (git-ignored)

## Conventions (non-default)
- `wait --text` / `wait --url` ARE the assertions (non-zero exit fails the step). Optional `assert.stdoutIncludes`.
- Deterministic locators only (`--url`, `--text`, `find role|text|label`); the AI `chat` command is never used.
- Flows target read-only seeded data (repo `acme/payments-api`, PR #482) — nothing triggers a model call.

## Do-not-touch
- NEVER `docker compose down -v` to "reset" — `-v` drops `devdigest_pgdata` (all imported repos/reviews).
- Flows 02/04/05 assume the seeded repo is the ONLY repo — keep them on the hermetic runner.

## Read when
- **`README.md`** — how a flow works, run modes, coverage table.
- **`../client/README.md`** — the UI routes/text these flows assert against.
- **`../docs/architecture.md`** — the end-to-end flow the journeys exercise.
- **`INSIGHTS.md`** — before debugging flaky / wrong-repo flow failures.
