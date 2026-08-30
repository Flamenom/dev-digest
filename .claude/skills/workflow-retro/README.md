# Workflow Retro Skill

A **retrospective / post-mortem** for a multi-agent run. After a workflow finishes — `/run-plan`,
the spec → plan → implement chain, a `Workflow()` fan-out, or any batch of sub-agents — invoke this
skill to find out **what it cost, where it struggled, what it wasted, and what to change next time**,
then log a trend row so runs can be compared over time.

## Manual only

This skill is **never** run automatically. It is invoked by hand when you decide a run is worth
reviewing. It is **not wired to any hook**, `Stop`/`SubagentStop` event, or the tail of another
skill, and must not be added to `settings.json` — retros cost tokens, so you choose when to spend them.

## Counts nested sub-agents

Sub-agents can spawn their own sub-agents (e.g. `spec-creator` / `implementation-planner` fan out
`researcher`s; a `Workflow()` fans out many). These **nested** agents are included in the per-agent
breakdown and in the totals. A parent's in-context `<usage>` excludes its children, so for runs that
used a spawning agent the skill prefers `deep` mode — journals are flat in `subagents/`, each with a
`.meta.json` carrying `agentType` + `spawnDepth`, so all depths are summed. (Example: a run that
looked like "1 agent" in-context was really 1 top-level + 4 nested = 5 agents.)

## What it does

Runs in the main session as the **analyst**. It does not re-run the workflow and does not edit agent
definitions or product code — it **analyses and recommends**. Applying a recommendation is a
separate, explicitly-approved follow-up.

```
finished multi-agent run
  └─ scope the run            (which agents / which batch)
       └─ collect metrics      (in-context by default · `deep` parses JSONL journals)
            └─ analyse          (cost/resource + process + qualitative dimensions)
                 └─ recommend   (actionable: brief / duplication / concurrency / topology / cache)
                      └─ report to chat  +  one trend row → docs/retros/ledger.md
```

## When to invoke

- `/workflow-retro` (optionally `label:<slug>`, `deep`, `scope:session`)
- Phrases: "retro this run", "workflow retrospective", "analyze that multi-agent run",
  "how did that workflow go".

## Inputs

| Token | Meaning | Default |
|-------|---------|---------|
| `label:<slug>` | Name for the run under review | derived from run / date |
| `deep` | Parse on-disk JSONL journals for exact token/cache/tool/timing data | off (in-context only) |
| `session:<id>` | Which session transcript to parse in `deep` mode | current session |
| `scope:last` / `scope:session` | Most recent agent batch, or every agent in the session | `last` |
| `no-ledger` | Print only; skip the ledger trend row | off |

## Data sources

| Source | When | Gives |
|--------|------|-------|
| **In-context** | default | `<usage>` per agent (tokens, tool_uses, duration), launch order, parallelism, reports — zero file reads |
| **Deep (JSONL)** | `deep` flag | exact per-turn input/output/**cache-read**/cache-creation tokens, tool calls, timestamps, parallelism factor — via `scripts/analyze_journals.py` |

Journals live at `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-*.jsonl` and the
main `~/.claude/projects/<project-slug>/<session-id>.jsonl`.

## Dimensions measured

- **Cost & resources:** tokens (in/out/cache), cache efficiency, tool calls, durations, agent count,
  launch order, parallelism factor, critical path, cost, cost-per-useful-output.
- **Process & effectiveness:** clarifying round-trips, rework/fix-loops, delegation correctness,
  scope drift, failure taxonomy.
- **Qualitative:** what was hard, what was easy, duplicated context, what was missed.

## Output

- Full report to chat (metrics table + well/hard/wasteful + actionable recommendations).
- One trend row appended to `docs/retros/ledger.md` (created if missing) — the only file write.
- An offer to apply a recommendation (never applied automatically).

## Cost estimate note

Pricing is **not** hard-coded — it drifts. For a `$` estimate, confirm current per-model rates via
the `claude-api` skill and pass them to the helper with `--prices prices.json`. Without prices, cost
shows `n/a`.

## File structure

```
workflow-retro/
├── SKILL.md                     ← analyst — phases: scope → collect → analyse → recommend → report
├── tile.json                    ← skill metadata
├── README.md                    ← this file
└── scripts/
    └── analyze_journals.py      ← read-only, stdlib-only JSONL parser for `deep` mode
```

## Relationship to other skills

- `/run-plan` **builds** a feature (implement → test → review → fix). `workflow-retro` looks **back**
  at how that run (or any multi-agent run) performed.
- `engineering-insights` captures durable per-module technical discoveries in
  `<module>/insights/INSIGHTS.md`. `workflow-retro` is about the **run/process**, not the code; its
  durable output is the `docs/retros/ledger.md` trend log.