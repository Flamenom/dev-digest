# PR Self Review — skill routing table

Maps changed files in the diff to the reviewer skills that must run on them.
Static rows take priority; the dynamic rule at the bottom picks up skills added
after this table was written.

A file can match several rows — every matching skill runs on it. Spawn one
review subagent per activated skill; each subagent receives only the files
(and changed-line ranges) that routed to its skill.

## Static routing

| Diff file pattern | Skills | Review focus |
|---|---|---|
| `client/src/**/*.ts(x)` (non-test) | `frontend-ui-architecture` | where code lives, component splitting, colocation, server/client boundary |
| `client/src/**/*.ts(x)` (non-test) | `react-best-practices` | hooks misuse, state patterns, component design anti-patterns |
| `client/src/**/*.ts(x)` (non-test) | `next-best-practices` | file conventions, RSC boundaries, async APIs, data patterns |
| `client/**/*.test.ts(x)` | `react-testing-library` | query priority, userEvent, async patterns, mocking |
| `server/src/**`, `reviewer-core/src/**` | `onion-architecture` | ring placement, illegal imports, dependency rule, reviewer-core purity |
| `server/src/**/routes.ts`, `server/src/modules/index.ts`, `server/src/platform/**` | `fastify-best-practices` | route/plugin structure, schema validation, error handling, lifecycle |
| `server/src/db/**`, `**/schema*.ts` | `drizzle-orm-patterns` | schema definition, query safety, transactions, migration workflow |
| `server/src/db/migrations/**`, `server/src/db/schema*.ts` | `postgresql-table-design` | data types, indexing, constraints |
| any file adding/changing `z.object(...)` / Zod schemas | `zod` | parsing vs validation, safeParse, error handling, inference |
| route handlers, auth, user input, uploads, secrets/config, SQL | `security` | OWASP Top 10: injection, authz, secrets, unsafe input handling |
| any `*.ts` / `*.tsx` in the diff | `typescript-expert` | one baseline pass over the whole diff; report only high-signal type-safety issues |

## Never route

`mermaid-diagram`, `engineering-insights` — not code reviewers.

## Dynamic discovery (skills not in this table)

1. List `.claude/skills/*/SKILL.md`; for any skill not named above (and not in
   "Never route"), read only its frontmatter `description`.
2. If the description clearly targets a category of files present in the diff,
   route those files to it with the same subagent contract as static rows.
3. If unsure whether a skill applies — skip it. The gate must stay predictable;
   a fuzzy match that blocks a push is worse than a missed advisory pass.
