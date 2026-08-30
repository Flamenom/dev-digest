---
name: workflow-retro
description: >
  Post-mortem / retrospective for a multi-agent run. Run it AFTER a workflow finishes
  (/run-plan, the spec → plan → implement chain, a Workflow() fan-out, or any batch of
  sub-agents) to collect how the run actually went and turn it into actionable change.
  Gathers cost & resource metrics (tokens, cache efficiency, tool calls, durations,
  agent count, launch order, parallelism), reconstructs qualitative insights (what was
  hard, what was easy, what context was duplicated, what was missed), and ends with
  concrete recommendations (improve an agent's brief, pre-fetch a shared file once, merge
  or split agents, change concurrency). Outputs a full report to chat and appends one
  trend row to docs/retros/ledger.md.
  TRIGGER only when explicitly asked: "/workflow-retro", "retro this run", "workflow
  retrospective", "analyze that multi-agent run", "how did that workflow go".
  Does NOT cover: running the workflow itself, editing product code, pushing/merging.
---

# Workflow Retro — retrospective for a multi-agent run

> **Hand me a finished multi-agent run and I tell you what it cost, where it struggled, what
> it wasted, and exactly what to change next time — then log a trend row so runs can be compared.**

You are the **analyst**, running in the main session. The workflow already ran; your job is to
look back at it. You read metrics and reports, reason about them, and produce a report plus
recommendations. **You do not re-run the workflow and you do not edit agent/skill definitions or
product code** — you *recommend* changes and, if the user says yes, that application is a separate
follow-up step.

## Manual only — never automatic

This skill is **invoked by hand**, on demand, after a run the user wants to review. There is **no
hook and there must never be one**: do not wire it to a `Stop`/`SubagentStop`/`PreToolUse` event,
do not chain it at the end of another skill or workflow, and do not register it in `settings.json`.
The user runs it explicitly when a run is worth reviewing. If you ever see it auto-triggering, that
is a bug — stop and tell the user.

## Count nested sub-agents (do not undercount)

A sub-agent can spawn its **own** sub-agents (e.g. `spec-creator` and `implementation-planner` hold
the `Agent` tool and fan out `researcher`s; a `Workflow()` fans out many). These **nested** agents
consume real tokens and tool calls and **must be included** in the per-agent breakdown and in every
total.

- **They are easy to miss in-context.** A parent agent's `<usage>` block reports only the parent's
  own tokens — it does **not** include its children's. So the in-context view of a run that used a
  spawning agent **undercounts** the real cost (one observed run looked like "1 agent / ~75k" but
  was really **5 agents** — a `spec-creator` plus 4 nested `researcher`s — at a far higher true total).
- **Deep mode catches them.** Journals are stored **flat** in `subagents/`, so a plain
  `agent-*.jsonl` glob already includes every nesting level. Each journal has a sibling
  `<journal>.meta.json` with `agentType`, `description`, and **`spawnDepth`** (1 = spawned by the
  main session, > 1 = nested). The helper reads these, indents nested agents under their depth, and
  **sums all depths into the total**.
- **Rule:** whenever the run used an agent that can spawn sub-agents — or you simply are not sure —
  prefer `deep`, or at minimum state in the report that the in-context totals exclude nested agents.

## Inputs (args)

| Token | Meaning | Default |
|-------|---------|---------|
| `label:<slug>` | Name for this retro (the run under review). | derived from the run / date |
| `deep` | Parse the on-disk JSONL journals for exact token / cache / tool / timing data. | off (in-context metrics only) |
| `session:<id>` | Which session transcript to analyse in `deep` mode. | the current session |
| `scope:last` / `scope:session` | Review just the most recent agent batch, or every agent in the session. | `last` |
| `no-ledger` | Print the report only; do not append a trend row. | off (ledger row is written) |

If it is ambiguous *which* run to review (several distinct batches in one session), ask before
analysing — do not silently pick.

## Data sources (both are real; prefer the cheap one)

1. **In-context (default).** As orchestrator you saw every `Agent` result's `<usage>` block
   (`subagent_tokens`, `tool_uses`, `duration_ms`), every `<task-notification>`, the launch order,
   which agents were dispatched in the same message (parallel), and each agent's final report. This
   is enough for a solid retro with **zero file reads**.
2. **Deep (the `deep` flag).** Parse the JSONL journals for exact, per-turn numbers
   (input / output / **cache-read** / cache-creation tokens, tool-call counts, timestamps):
    - Subagent journals: `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-*.jsonl`
    - Main session transcript: `~/.claude/projects/<project-slug>/<session-id>.jsonl`
    - Run the bundled helper (read-only, stdlib-only):
      ```
      python3 .claude/skills/workflow-retro/scripts/analyze_journals.py \
        "~/.claude/projects/<project-slug>/<session-id>/subagents/agent-*.jsonl" --json
      ```
    - It prints per-agent and total tokens, **cache hit ratio**, tool calls, wall-clock span, and a
      **parallelism factor** (Σ agent spans ÷ wall-clock). Nested sub-agents (spawnDepth > 1) are
      indented under their parent and **included in the totals** (the summary reports `nested=` and
      `max_depth=`). For a cost estimate pass `--prices prices.json`; **do not hard-code prices —
      confirm current per-model rates via the `claude-api` skill first**, since they drift.

   Find the project slug / session id from the symlink targets under the session's `tasks/`
   directory, or by matching the most recently modified `*.jsonl` under
   `~/.claude/projects/<project-slug>/`.

## What to measure (the dimensions)

Collect what you can; mark anything unavailable as `n/a` rather than guessing.

**Cost & resources (quantitative)**
- Tokens — input / output / cache-read / cache-creation, **per agent and total**.
- **Cache efficiency** = cache-read ÷ total input-side tokens. Low ratio = something is breaking
  the prompt cache (a big cost lever).
- Tool calls per agent and total.
- Wall-clock per agent and total; **parallelism factor** = Σ(agent spans) ÷ wall-clock.
- **Critical path** — the single agent that dominated wall-clock.
- Cost ($) per agent and total (only with verified prices), plus **cost per useful output**
  ($/finding, $/spec, $/fixed-task) — a better signal than raw spend.

**Process & effectiveness**
- Agent count **including nested sub-agents** (report depth-1 vs nested separately, e.g.
  "5 agents: 1 top-level + 4 nested"), **launch order**, and the parallelism map (which ran
  concurrently vs serially, at every depth).
- **Clarifying round-trips** per agent — how often it had to be re-prompted or corrected. High =
  the dispatch brief was underspecified.
- Rework — fix-loop iterations, retries, re-spawns.
- Delegation correctness — did the right agent type take each task; did agents stay in their
  owned paths / scope (scope drift).
- **Failure taxonomy** — terminal API errors, tool denials, blocked-on-human; categorise so
  recurring friction surfaces.

**Qualitative insights**
- **What was hard** — where agents stalled, looped, or asked questions.
- **What was easy** — what went cleanly first try.
- **Duplicated information** — the same large file read by multiple agents, the same context
  re-sent, overlapping work → candidates for a single shared pre-read.
- **What was missed** — gaps the orchestrator or the human caught only afterwards.

## Method

1. **Scope the run.** Decide which agents/workflow this retro covers (`scope`, or ask if
   ambiguous). List them with their roles.
2. **Collect metrics.** In-context by default; if `deep`, locate the journals and run the helper.
   Build the per-agent table + totals.
3. **Analyse** across the dimensions above. Separate the *quantitative* findings (from the table)
   from the *qualitative* ones (from the reports and your own observation of the run).
4. **Recommend.** Turn each finding into a concrete, owned action (see *Recommendations*). No vague
   "could be better" — name the agent, the file, or the parameter, and the expected effect.
5. **Output** the report (below) to chat. Unless `no-ledger`, append one trend row to
   `docs/retros/ledger.md` (create the file with a header if missing). Writing that ledger row —
   and an optional full per-run file under `docs/retros/` — is the **only** file write this skill
   makes.
6. **Offer**, but do not perform, the follow-up: "want me to apply recommendation X?" Applying it
   (editing an agent prompt, a skill, the orchestration) is a separate, explicitly-approved step.

## Recommendations — make them actionable

Each recommendation names a target, a change, and the expected payoff. Examples of the *shape*:

- *Brief:* "`implementer` for T-3 needed 2 clarifying round-trips on owned paths — add the sibling
  tasks' owned-paths to its dispatch brief." → fewer round-trips, less token churn.
- *Duplication:* "3 agents each read `server/docs/architecture.md` (~4k tokens ×3) — have the
  orchestrator read it once and pass the relevant excerpt." → ~8k tokens saved per run.
- *Concurrency:* "review agents ran serially but have disjoint inputs — dispatch them in one
  message." → wall-clock down from Σ to max.
- *Topology:* "agents A and B always run back-to-back on the same files — consider merging." /
  "agent C did two unrelated jobs — consider splitting."
- *Cache:* "cache hit ratio 38% — the dynamic block is injected before the stable one; reorder so
  the stable prefix is cached."

## Output format (report)

```
## Workflow Retro — <label>

**Run:** <what ran> · <N> agents · mode <multi|single> · data: <in-context | deep>

### Metrics
| agent | role | in | out | cache-read | hit% | tools | span | cost |
|-------|------|----|----|-----------|------|-------|------|------|
| …     | …    | …  | …  | …         | …    | …     | …    | …    |
**Totals:** in <…> · out <…> · cache hit <…>% · tools <…> · wall <…>s · parallelism <…>x · cost <…>
**Launch order:** A → (B ‖ C) → D     **Critical path:** <agent> (<…>s)

### What went well
- <…>

### What was hard / wasteful
- <difficulty / stall> — <evidence>
- <duplicated context> — <which agents, ~tokens>
- <what was missed> — <caught when / by whom>

### Recommendations (actionable)
1. <target> — <change> → <expected effect>
2. …

### Ledger
Appended to `docs/retros/ledger.md` (row: <date> · <label> · agents · tokens · cost · parallelism).
```

### Ledger row format (`docs/retros/ledger.md`)

A single Markdown table; one row per retro so runs can be compared over time:

```
| date | label | agents | in→out tok | cache hit | wall | parallelism | cost | top recommendation |
|------|-------|--------|-----------|-----------|------|-------------|------|--------------------|
```

## When you cannot proceed

If no multi-agent run is identifiable in scope (e.g. invoked with nothing to review), or `deep` is
requested but the journals cannot be located, say so plainly and offer the in-context retro instead.
A clear "nothing to retro / journals not found, here's the in-context view" is a valid result — a
fabricated metric is not.