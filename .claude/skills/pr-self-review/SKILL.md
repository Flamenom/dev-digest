---
name: pr-self-review
description: "Pre-PR quality gate for local changes. Reviews everything the future PR will contain (commits ahead of main + uncommitted changes) by routing diff files to the project's specialized skills — UI skills over client files, backend/architecture skills over server and reviewer-core files — then adversarially verifies every critical finding and writes a pass/fail verdict keyed to the current HEAD that blocks `git push` / `gh pr create` while any confirmed critical finding exists. Use before opening a pull request, when the user says 'self review', 'pr self review', 'pre-PR check', 'перевір перед PR', or when the pr-gate hook blocked a push and directed here."
argument-hint: "[--scope client|server|reviewer-core] [--skill <name>]"
---

# PR Self Review

Reviews the local branch as if it were an already-open PR, using the project's
own skills as the rulebooks, and gates `git push` / `gh pr create` on the
result. The verdict lives in `.git/pr-self-review.json`; `scripts/pr-gate.sh`
(wired as a PreToolUse hook) refuses pushes without a fresh passing verdict.

Arguments: `--scope <pkg>` limits review to one package's files; `--skill
<name>` runs only that skill's pass. A scoped/partial run still writes a
verdict, but marks `"partial": true` — the gate treats partial verdicts as
non-passing, so only a full run unblocks a push.

## Step 1 — Collect the diff

1. `BASE=$(git merge-base main HEAD)`. Changed files = union of
   `git diff --name-status $BASE...HEAD` and `git diff --name-status HEAD`
   (uncommitted). Warn if the current branch IS main.
2. Exclude from review: `pnpm-lock.yaml`, `*.lock`, `client/messages/**`,
   generated files, `server/clones/**`, binary files.
3. **Size guard:** if more than 40 files remain, stop and ask the user to
   either confirm the full (token-expensive) run or narrow with `--scope`.
4. For every remaining file, extract changed-line ranges from the `@@` hunk
   headers of `git diff -U0 $BASE...HEAD -- <file>` plus
   `git diff -U0 HEAD -- <file>`. These ranges travel with the file into every
   reviewer prompt.

## Step 2 — Deterministic checks (no LLM)

Run before any subagent; each failure is a **confirmed critical** (facts skip
Step 5 verification):

- Modified (not added) file under `server/src/db/migrations/` → critical.
- Modified (not added) existing contract file in `server/src/vendor/shared/`
  or the client's shared copy → critical (contracts are extend-only).
- `cd server && pnpm arch` — run if any `server/src/**` or
  `reviewer-core/src/**` file changed; non-zero exit → critical per violation.
- `pnpm typecheck` in each package that has changed files; failure → critical.

## Step 3 — Route skills onto files

Follow `references/routing.md`: static table first, dynamic discovery for
skills the table doesn't know, "never route" list respected. Output of this
step: a list of (skill → files + changed-line ranges) groups. Skills with no
matching files do not run.

## Step 4 — Parallel review subagents

Spawn one read-only subagent per routed skill, all in a single batch so they
run concurrently. Each prompt must contain:

- the instruction to read `.claude/skills/<skill>/SKILL.md` and use it as the
  only rulebook — the subagent reviews against that skill, nothing else;
- the routed files with their **changed-line ranges**, and the diff hunks;
- the scope rule and the finding contract below, verbatim.

**Scope rule (changed lines only).** A finding is valid only if (a) its
`file:line` falls inside a changed-line range, or (b) the change itself
directly creates a problem elsewhere (e.g. a new import that breaks the
dependency rule, a renamed export that orphans a caller). Reading surrounding
code for context is encouraged; reporting pre-existing problems in unchanged
lines is forbidden — this gate judges the PR, not the legacy around it.

**Finding contract.** Each subagent returns a JSON array; each finding:

```json
{
  "severity": "critical | major | minor",
  "file": "server/src/modules/reviews/service.ts",
  "line": 42,
  "rule": "<skill-name>/<short-kebab-slug>",
  "summary": "one sentence: what is wrong",
  "evidence": "why this violates the named skill rule, citing the rule",
  "fix": "one sentence: the suggested correction"
}
```

**Critical criteria — closed list.** A subagent may mark `critical` ONLY for:

1. Do-not-touch violations from CLAUDE.md: editing existing shared contracts,
   editing applied migrations, reviewer-core purity (DB/GitHub/FS imports),
   bypassing the grounding gate / deterministic re-score.
2. Onion dependency-rule violations (illegal ring import).
3. Exploitable security vulnerability: injection, authz bypass, committed
   secret, unsafe deserialization of user input.
4. A change that breaks the web↔api↔engine contract lockstep.

Everything else caps at `major`. When unsure between critical and major —
major. Inflated severity gets stripped in Step 5 anyway and wastes a
verification agent.

## Step 5 — Suppressions, then adversarial verification of criticals

1. Read `.claude/pr-review/suppressions.json`. Drop any finding matching a
   suppression on (`file`, `rule`); keep a "suppressed" list for the report.
   Entry shape:
   `{"file", "rule", "reason", "author", "added": "YYYY-MM-DD"}`.
2. For every remaining LLM-produced **critical** finding, spawn one verifier
   subagent (fresh context, read access to the full repo — not just the diff)
   with the task: *"Try to refute this finding. Read the whole file and its
   callers. Answer confirmed / refuted / uncertain with evidence."* Run
   verifiers in parallel.
   - **confirmed** → stays critical;
   - **refuted** → dropped, noted in the report with the refutation;
   - **uncertain** → demoted to major, noted as unverified.
   Deterministic criticals from Step 2 skip verification — they are facts.

## Step 6 — Verdict and report

1. Verdict = `fail` if ≥1 confirmed critical, else `pass`. Write
   `.git/pr-self-review.json`:

```json
{
  "verdict": "pass",
  "head_sha": "<git rev-parse HEAD>",
  "worktree_hash": "<git diff HEAD | git hash-object --stdin>",
  "timestamp": "<UTC ISO>",
  "partial": false,
  "counts": { "critical": 0, "major": 2, "minor": 5 },
  "skills_run": ["onion-architecture", "react-best-practices"],
  "suppressed": 1
}
```

   `head_sha` + `worktree_hash` bind the verdict to the exact reviewed state:
   any new commit or uncommitted edit invalidates a stale `pass`.

2. Print the report: verdict first, then findings grouped
   critical → major → minor (each as `severity · file:line · rule — summary +
   fix`), then dropped/demoted criticals with refutations, then suppressed
   findings. If `fail`: name the criticals to fix and say that `git push` /
   `gh pr create` stay blocked until a re-run passes.

3. Majors and minors never block; they are advisory. Do not fix findings
   unless the user asks — this skill reports.

## Escape hatch (emergencies only)

`PR_GATE_SKIP=1 PR_GATE_SKIP_REASON="why" git push` bypasses the gate;
pr-gate.sh refuses a skip without a reason and appends every skip to
`.git/pr-self-review-skips.jsonl`. Never suggest the skip as a way around
findings — it exists for broken-gate emergencies.
