# DevDigest project subagents

Map of the agent set in `.claude/agents/`. Each file is the single source of
truth for its agent — this README only describes how the set fits together.

Intended chain: **researcher** (facts) → **planner** (plan) → **implementer**
(code) → review/security passes (separate agents / `pr-self-review` gate —
deliberately NOT part of implementer).

| Agent | Responsibility | Tools | permissionMode | Model |
| --- | --- | --- | --- | --- |
| `researcher` | Read-only investigations: repo facts + external docs, with citations | Read, Glob, Grep, Bash, WebFetch, WebSearch | default | `sonnet` (pinned) |
| `planner` | Structured, skill-aware Development Plans; never implements | Read, Glob, Grep, Bash | `plan` | inherit |
| `implementer` | Executes an approved plan (frontend + backend); verifies within implementation scope only | Read, Edit, Write, Glob, Grep, Bash, Skill | default | inherit |

## researcher

- **In:** a concrete question (repo, external, or mixed). Vague input triggers
  interview mode instead of research.
- **Out:** structured research report (Conclusions / Evidence / Not found) or
  a `CLARIFICATION NEEDED` question list. Every claim is cited
  (`file:line` or fetched URL); gaps are stated, never guessed.

## planner

- **In:** a feature/task description; optionally a researcher report. Grounds
  itself in in-scope `INSIGHTS.md`, `specs/*.md`, per-package `CLAUDE.md`.
- **Out:** a Development Plan (`Result / Context / Scope / Constraints /
  Tasks / Skills applied / Verification / Out-of-scope · Follow-ups`). Each
  task names the exact skills implementer will apply, via the skill routing
  table shared verbatim between both agents.
- **Skills:** 10 preloaded via frontmatter (onion-architecture,
  frontend-ui-architecture, next/fastify best practices, drizzle, postgres,
  zod, react best practices, react-testing-library, mermaid-diagram). No
  `Skill` tool — preloaded content only.

## implementer

- **In:** an approved Development Plan (no plan → stops and asks). Reads the
  per-package `CLAUDE.md`/`INSIGHTS.md` of every touched package.
- **Out:** an Implementation Report (`Result / Changed / Skills applied /
  Verification / Out-of-scope · Follow-ups`); failures reported verbatim.
- **Skills:** 11 preloaded — planner's set minus mermaid, plus
  typescript-expert and `security` (secure CODING while writing auth/input/
  endpoint code — not a review pass). Review skills (`security-review`,
  `pr-self-review`, `aif-review`, `code-review`) are explicitly forbidden;
  never pushes or opens PRs.

## Sources for planner/implementer rules

- [Subagents — Claude Code docs](https://code.claude.com/docs/en/sub-agents) —
  frontmatter schema, description-based delegation ("use proactively"),
  least-privilege tool allowlists, `skills:` preload semantics, and the
  canonical planner/implementer split (read-only + `permissionMode: plan` vs
  read + Edit/Write/Bash).
- [Skills — Claude Code docs](https://code.claude.com/docs/en/skills) —
  how preloaded skills interact with subagent context and the `Skill` tool.
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
  — Explore → Plan → Implement → Commit separation; adversarial review as a
  SEPARATE fresh-context step (why implementer does no arch/security review).
- [Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
  — concise, third-person descriptions; on-demand context over duplication.
