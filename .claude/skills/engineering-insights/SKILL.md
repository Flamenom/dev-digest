---
name: engineering-insights
description: Capture and reuse non-obvious engineering learnings in the repo's per-package INSIGHTS.md files. Reads the in-scope INSIGHTS.md before work and, at session end, appends only substantial, non-duplicate insights (patterns, mistakes, decisions, gotchas), each citing file:line. Use at the start of any coding task to load prior learnings, when a non-obvious gotcha/decision/fix surfaces mid-session, and at end of session to record what was learned. Does NOT review code, run tests, edit @devdigest/shared contracts or applied migrations, or add hooks.
argument-hint: [package scope | "wrap-up"]
allowed-tools: Read Grep Glob Edit
disable-model-invocation: false
---

# Engineering Insights

Persist what a session learned about *this* codebase into the repo's per-package
`INSIGHTS.md` files, and load it back at the start of the next task. A markdown-native
"learnings loop" — no vector DB, no infra. This is the storage the repo already scaffolds
(5 `INSIGHTS.md`, one per scope, each linked from its `CLAUDE.md`); this skill supplies the
read-before-work / capture-at-end behavior.

`allowed-tools` deliberately omits `Write` — this skill can only **insert** into an
INSIGHTS.md via `Edit`, never overwrite a whole file. See the safety invariant below.

## When to Use

Two triggers:

- **Session-start read** — when a coding task begins, read the INSIGHTS.md for the scope in
  play and confirm the top relevant points *before* touching code.
- **Wrap-up capture** — at the end of a session, record substantial, durable learnings.

Cadence gate: capture is worth it for a session that hit a real problem, made a decision, or
discovered something non-obvious (roughly: >30 min, multiple tasks, errors, or user
corrections). Skip trivial edits — see Step 0.

> **Note for now (course L01):** this skill is model-/manually-invoked, so end-of-session
> capture depends on remembering to run it. That unreliability is expected — a later lesson
> (L06) adds a `Stop` hook, bundled inside this skill folder and active only while engaged,
> to make capture automatic. This skill does **not** add a hook today.

## Step 0 — Gate Check (silent)

Before writing anything, silently score the session's depth:

- distinct tasks/subtasks attempted
- errors or failures hit and resolved
- explicit user corrections ("no, do it this way")
- non-obvious fixes, decisions with trade-offs, or environment quirks discovered

**If the session is shallow (one trivial task, no errors, nothing non-obvious) → write
NOTHING.** Say so in one line ("Nothing substantial to capture this session.") and stop.
Do not manufacture entries to look productive. An empty, correct file beats a padded one.

## Routing — which of the 5 files

Pick the target by the paths the work actually touched:

| Touched area | Target |
|---|---|
| `server/**` (incl. any `src/modules/*`, `adapters/*`, `platform/*`) | `server/INSIGHTS.md` |
| `client/**` | `client/INSIGHTS.md` |
| `reviewer-core/**` | `reviewer-core/INSIGHTS.md` |
| `e2e/**` | `e2e/INSIGHTS.md` |
| cross-cutting, multi-package, or unclear | root `INSIGHTS.md` |

There are exactly **5** files — do not create per-module INSIGHTS.md. A learning about a
`server/src/modules/*` module still goes to `server/INSIGHTS.md`. Distribute to the nearest
scope; never dump everything into the root file.

## Append-only safety invariant — TOP PRIORITY

This skill **NEVER** overwrites, deletes, reorders, rewrites, or truncates any existing line
in an INSIGHTS.md. It only **inserts** new entries.

- **Mechanism:** use `Edit` with the target **section heading as the unique anchor**, and
  insert the new entry immediately under it (newest-first). Replace only the heading line
  with `heading + "\n" + new entry`. Never `Write` an INSIGHTS.md — `Write` replaces the
  whole file and is forbidden here (and absent from `allowed-tools`).
- **Corrections:** if a new insight refines or contradicts an existing entry, add a **new
  dated note** — never edit or delete the old line.
- **No pruning on the capture path:** merging, consolidating, or removing entries is a
  separate, human-in-the-loop maintenance action. Capture must never prune.
- **Verify before finishing:** re-read the file and confirm every pre-existing entry is
  still present verbatim and only your new lines were added. If you cannot guarantee a clean
  insert (ambiguous anchor, unexpected content), **stop and report** rather than risk a
  clobber.

## Procedure (wrap-up)

1. **Read the target INSIGHTS.md in full first** — always, before writing.
2. **Substance + anti-platitude gate** — each candidate must name a concrete
   file/command/symbol and pass *"would this save 5+ minutes next time, or stop me
   repeating a mistake?"*. Reject vague lines ("be careful with the DB", "async is tricky").
   See `references/rubric.md` for the good-vs-vague bar.
3. **Dedup (hard rule)** — drop any candidate already covered by an existing entry. If it
   genuinely refines/contradicts one, add a dated correction (per the invariant above).
4. **Cap** — at most **5 new entries per session**, highest-value first. If a file is
   approaching ~80–100 entry lines, note it needs a prune/split (a human action) instead of
   growing it further.
5. **Insert (append-only)** under the correct section, newest-first, in the entry format
   from `references/rubric.md`, via `Edit` anchored on the section heading.
6. **Promote** — if a learning keeps biting across sessions, add a one-line pointer into the
   scope's `CLAUDE.md` (the repo's existing "promote a one-liner into CLAUDE.md" guidance).
7. **Interaction budget** — confirm the shortlist once (if confirming at all), then insert
   silently. Do not ask per entry.

## Session-start use

When invoked at task start (or when you read this skill before coding): open the in-scope
INSIGHTS.md, and briefly summarize the top ~3 relevant entries for the task at hand before
writing code. Apply "What Works" / "Codebase Patterns" and avoid anything under "What Doesn't
Work". Active summarization (not passive skim) is what makes the loop pay off.

## Quick Reference

| Capture category | INSIGHTS.md section | File it when… |
|---|---|---|
| Pattern | What Works | a concrete approach proved reliable here |
| Mistake / antipattern | What Doesn't Work | something failed and you know why + the fix |
| Context | Codebase Patterns & Tool/Library Notes | a non-obvious convention, tool flag, or env quirk |
| Decision | Decisions — with the why | a trade-off was made; record the reasoning |
| Recurring error | Recurring Errors & Fixes | the same symptom → fix keeps coming up |
| Unknown | Open Questions | a real open question worth the next session's time |

Entry shape (details in `references/rubric.md`):
```
- <atomic imperative insight>. Evidence: <file:line>. Confidence: <high|med|low>. (YYYY-MM-DD)
```

## What this skill does NOT do

- It does **not** review code quality, run tests, or analyze PRs.
- It does **not** edit `@devdigest/shared` contracts, applied `server/src/db/migrations/*`,
  or `server/clones/` (repo do-not-touch list).
- It does **not** add hooks or change `.claude/settings.json` (that is the L06 lesson).
- It does **not** overwrite or prune INSIGHTS.md — insert-only (see the safety invariant).

## References

- `references/rubric.md` — capture categories, the anti-platitude test, DevDigest-real
  good-vs-vague examples, and the entry template.
- `references/template.md` — the sectioned INSIGHTS.md skeleton + one worked example.
