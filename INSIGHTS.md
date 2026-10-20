# Insights — DevDigest (cross-cutting)

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here

## What Doesn't Work — antipatterns & mistakes

## Codebase Patterns & Tool/Library Notes

- The `rtk` hook wrapper also rewrites `git` output. `git diff HEAD | git hash-object --stdin` run through it gave `8b13789…` on a clean tree instead of the empty-blob `e69de29…` that `scripts/pr-gate.sh` computes. A hand-written `.git/pr-self-review.json` then looks stale and blocks the push. Compute `head_sha` / `worktree_hash` with `rtk proxy git …` when writing the verdict. Evidence: scripts/pr-gate.sh:42. Confidence: high. (2026-10-20)

- This repo is a FORK and `gh` resolves the PARENT (`git config remote.origin.gh-resolved` = `base`), so `gh variable|secret|api|pr` without `-R Flamenom/dev-digest` hits the upstream course repo — an earlier `gh variable set` wrote there. Always pass `-R Flamenom/dev-digest`. Evidence: .git/config (`remote.origin.gh-resolved`). Confidence: high. (2026-10-19)
- Pushing changes under `.github/workflows/**` needs a token with the `workflow` scope; the macOS Keychain PAT lacks it and the push is rejected. Push with `git -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' push`, or run `gh auth setup-git` once. Evidence: .github/workflows/harness-evals.yml. Confidence: high. (2026-10-19)
- The `rtk` hook wrapper can misreport output and exit codes of `eslint` / `grep` (e.g. "JSON parse failed", "0 matches in 0 files" while matches exist). When a result looks wrong, re-run as `rtk proxy <cmd>` before debugging. Evidence: client `pnpm lint` (verification matrix in docs/plans/2026-10-19-next-steps.md). Confidence: high. (2026-10-19)
- The harness-evals workflow tier needs a model that actually invokes Claude Agent SDK tools; `google/gemini-2.5-flash` (the fallback) never calls skills, so workflow cases fail. The fork sets repo variable `EVAL_MODEL_WORKFLOW=anthropic/claude-haiku-4.5`. Evidence: .github/workflows/harness-evals.yml:159. Confidence: high. (2026-10-19)

- `server/` node_modules is linked to a pnpm v11 store while the global pnpm is v10 — `pnpm add` there fails with a store-version mismatch; use `npx pnpm@11 add <pkg>` inside `server/` (client/ is fine with the global pnpm). Evidence: server/pnpm-lock.yaml lockfileVersion vs `pnpm --version`. Confidence: high. (2026-08-18)
- `@devdigest/shared` contracts are vendored TWICE (server/src/vendor/shared, client/src/vendor/shared) — edit both in lockstep. A zod `.nullable()` field is required-but-null (the KEY must be present), so adding one (e.g. `RunStats.cost_usd`) breaks every fixture that builds the object (server/test/contracts.test.ts RunTrace.parse; client RunHistory/RunTraceDrawer test fixtures). Use `.nullish()` for a genuinely optional / list-only field like `PrMeta.cost_usd`. Evidence: server/src/vendor/shared/contracts/trace.ts:60, platform.ts:157. Confidence: high. (2026-07-31)
- Per-run LLM cost is already computed at runtime — never recompute it to re-surface it. reviewer-core's review outcome carries `costUsd` (OpenRouter `usage.cost`, else `estimateCost`/PriceBook fallback); the course "remove cost" commits (d45ab0d, 58c6ac7) stripped only server-persist + client-display, so re-adding is pure re-threading with zero extra model calls. Evidence: reviewer-core/src/review/run.ts:110,216; reviewer-core/src/llm/openrouter.ts:94-107. Confidence: high. (2026-07-31)

## Decisions — with the why

- Security-sensitive text transforms (escaping for a downstream renderer) must be checked against the REAL downstream parser, not a spec-compliant stand-in. The quick-action neutraliser passed its commonmark.js-based oracle while GitLab's comrak/GLFM still executed commands. Only a scratch-venv `comrak` (PyPI binding, configured with GitLab's options) plus a fuzz harness exposed it. Keep the repo test parser-independent (assert the invariant on raw lines) and use the real parser as an offline fuzz oracle. Also: in `/pr-self-review`, give the security reviewer concrete attack vectors; the generic pass missed this in the first round. Evidence: server/test/comment-body.test.ts; server/test/helpers/fake-gitlab.ts (`rawCommandLines`) (PR #15). Confidence: high. (2026-10-20)
## Recurring Errors & Fixes

- Correction to the entry below: the testcontainers `beforeAll` timeout is fixed (Task G7). Every server it-test now shares ONE Postgres, started lazily by a loopback broker in vitest `globalSetup`. Each file gets its own `CREATE DATABASE … TEMPLATE devdigest_template`, migrated once. Hermetic-only runs never start Docker. The full suite was green 3/3, with the critical path now the hermetic `rate-limit-per-user.test.ts` (~120 s). Evidence: server/test/global-setup.ts; server/test/helpers/pg.ts. Confidence: high. (2026-10-20)
- Correction to the Open Question below about the `reviews.it` / `gitlab-feature-parity.it` flakes: resolved. The root cause was a run marked terminal before its trace was saved (see server/INSIGHTS.md, TRACE_BEFORE_STATUS); after the fix, 10/10 full runs were green.
  - What still fails, rarely, under full-suite Docker load (about 24 testcontainers suites, up to 10 at once): a `beforeAll` passes the 120 s `hookTimeout` while the container starts, and strict latency budgets swing 10–20×. Rerun the file alone before debugging.
  - Keep exact perf budgets behind `PERF_STRICT=1` (run that file alone), with a loose sanity bound in the full suite.
  - The real fix is a shared Postgres via `globalSetup` (Task G7).
  - Evidence: server/vitest.config.ts:17; server/test/auth-perf.it.test.ts:21. Confidence: high. (2026-10-20)

- `ERR_MODULE_NOT_FOUND: Cannot find package 'openai' imported from reviewer-core/src/...` during `pnpm db:seed`, API boot, or server tests = reviewer-core deps not installed. reviewer-core is consumed as RAW source via a tsconfig alias, and its runtime deps (openai/zod) resolve from `reviewer-core/node_modules` — a SIBLING of `server/`, NOT an ancestor — so `server`'s own `openai` install can't satisfy them. Any step that loads reviewer-core must run `npm ci` in `reviewer-core/` FIRST (reviewer-core uses npm, not pnpm). Was ordered AFTER `db:seed` in e2e-web.yml → crash. Evidence: .github/workflows/e2e-web.yml (Install reviewer-core deps); server-integration.yml:56. Confidence: high. (2026-08-01)

## Open Questions

- Two server it-tests flake only under the full `pnpm exec vitest run` (always green alone): "map-reduce + grounding drops the hallucinated finding" and GitLab parity "1. review…" (once 404 on `POST /pulls/:id/review`). Suspected: cross-suite testcontainers state or asserting a fire-and-forget run before it finishes. Tracked as Task E. Evidence: server/test/reviews.it.test.ts:160; server/test/gitlab-feature-parity.it.test.ts:339. Confidence: med. (2026-10-19)
