# INSIGHTS.md template

The sectioned skeleton every INSIGHTS.md uses (only the H1 scope changes), plus a worked
example showing correctly-formatted entries.

## Skeleton

```markdown
# Insights — <scope>

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here
## What Doesn't Work — antipatterns & mistakes
## Codebase Patterns & Tool/Library Notes
## Decisions — with the why
## Recurring Errors & Fixes
## Open Questions
```

`<scope>` matches the existing H1 per file: `DevDigest (cross-cutting)`, `@devdigest/api`,
`@devdigest/web`, `@devdigest/reviewer-core`, `@devdigest/e2e`.

## Worked example (a populated `server/INSIGHTS.md`)

```markdown
# Insights — @devdigest/api

Read this before working here. Append only substantial, non-obvious learnings, and only if
not already captured. Newest-first within each section. Each entry names a file:line.
Cap ~5 new/session, ~80–100 lines/file (then prune/split). Promote persistent ones to CLAUDE.md.

## What Works — patterns proven here
- Mint runId synchronously before returning from a review POST so the client can SSE-subscribe; the run is fire-and-forget. Evidence: server/src/platform/sse.ts. Confidence: high. (2026-07-31)

## What Doesn't Work — antipatterns & mistakes
- Don't reach into a sibling module's folder for a cross-module entity — go through the container (container.repoIntel). Evidence: server/src/platform/container.ts. Confidence: high. (2026-07-31)

## Codebase Patterns & Tool/Library Notes
- Match ZodError by shape, not instanceof — zod is vendored twice, so instanceof fails across the vendor/api boundary. Evidence: server/src/vendor/shared. Confidence: high. (2026-07-31)

## Decisions — with the why
- A review's trace is saved as ONE run_traces doc (not per-step rows) so the client can replay a run from a single fetch. Evidence: server/src/platform/trace-builder.ts. Confidence: med. (2026-07-31)

## Recurring Errors & Fixes
- "relation ... does not exist" on boot → migrations not applied. Fix: cd server && pnpm db:migrate (NOT auto-run). Evidence: server/CLAUDE.md. Confidence: high. (2026-07-31)

## Open Questions
- Should stale-run reaping tolerate more than one API instance per DB? Current logic assumes exactly one. (2026-07-31)
```

## Inserting a new entry (append-only)

To add an entry, `Edit` the **section heading line** as the anchor and place the new bullet
immediately below it (newest-first), e.g. replace:

```
## What Works — patterns proven here
```

with:

```
## What Works — patterns proven here
- <new entry>. Evidence: <file:line>. Confidence: <high|med|low>. (YYYY-MM-DD)
```

Never replace the whole file, and never touch existing bullets.
