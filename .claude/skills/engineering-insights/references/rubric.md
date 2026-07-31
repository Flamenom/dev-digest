# Capture rubric

How to decide *whether* an insight is worth writing, *which* section it belongs in, and
*how* to phrase it. Read this before appending to any INSIGHTS.md.

## The one test (anti-platitude gate)

> Every entry must be specific enough that an agent reading it **cold** knows exactly what to
> do or avoid — without re-investigating.

Concretely, an entry qualifies only if **both** hold:

1. It names a real **file / command / symbol / path** (evidence you can jump to).
2. It passes: *"Would knowing this save 5+ minutes next time, or stop me repeating a
   mistake?"*

If it would be obvious to anyone who just read the code, or it's generic best practice
("write tests", "handle errors", "async is tricky") → **do not write it.**

## The four categories → sections

Mapped from the Patterns / Mistakes / Decisions / Context taxonomy onto the file's sections:

- **Pattern** → `## What Works` — a concrete approach proven reliable *here*.
- **Mistake / antipattern** → `## What Doesn't Work` — something that failed, why, and the fix.
- **Context** → `## Codebase Patterns & Tool/Library Notes` — a non-obvious convention, tool
  flag, or environment quirk.
- **Decision** → `## Decisions — with the why` — a trade-off that was made; record the reason,
  not just the outcome.

Plus two operational sections:

- `## Recurring Errors & Fixes` — the same symptom→fix that keeps reappearing.
- `## Open Questions` — a genuine unknown worth the next session's time (one line each).

Precedence when an insight fits two: a **user correction** outranks a tool failure; a
**Decision** (has a "why") outranks a bare Pattern.

## Entry format

One atomic, imperative line per insight, newest-first within its section:

```
- <atomic imperative insight>. Evidence: <file:line>. Confidence: <high|med|low>. (YYYY-MM-DD)
```

- **Atomic** — one insight per bullet. Split compound findings.
- **Imperative & cold** — "Mint runId sync before…", not "we found that we should…".
- **Evidence** — a real `path:line` (or a command). No evidence → it's probably a platitude.
- **Confidence** — optional but recommended for entries that may age; lets a later, proven
  entry override a stale low-confidence one instead of silently conflicting.
- **Date** — entries age; always stamp them.

## Good vs vague (DevDigest-real)

**Useful:**

- `Routes are keyed by PR number but every API is keyed by row uuid — resolve number→uuid from the cached PR list before any detail fetch. Evidence: client/src/lib/api.ts. Confidence: high. (2026-07-31)`
- `Mint runId synchronously before returning from a review POST so the client can SSE-subscribe; the run itself is fire-and-forget. Evidence: server/src/platform/sse.ts. Confidence: high. (2026-07-31)`
- `Never trust the model's score — it's recomputed deterministically from surviving grounded findings. Don't relax the grounding gate to "fix" a score. Evidence: reviewer-core/src/grounding.ts. Confidence: high. (2026-07-31)`
- `Match ZodError by shape, not instanceof — zod is vendored twice (vendor/shared vs api), so instanceof fails across the boundary. Evidence: server/src/vendor/shared. Confidence: high. (2026-07-31)`
- `"relation ... does not exist" on boot means migrations weren't applied — db:migrate is NOT auto-run: cd server && pnpm db:migrate. Evidence: server/CLAUDE.md. Confidence: high. (2026-07-31)`

**Vague (reject — no file/command, no 5-minute payoff):**

- `Be careful with the database layer.`
- `SSE can be tricky sometimes.`
- `Zod errors are confusing.`
- `Remember to run migrations.` (no symptom, no exact command)
- `The review engine has some gotchas.`

## Size & staleness (maintenance, NOT capture)

- Cap **≤ 5 new entries per session**; keep each file **≤ ~80–100 entry lines**.
- Over the ceiling → flag for a human prune/split. The capture path **never** removes or
  merges entries — that's a separate, human-in-the-loop review (monthly is a good cadence).
- When one entry keeps proving essential, promote a one-liner into the scope's `CLAUDE.md`.
