/**
 * L02 — seeded skill bodies for the Skills Lab (linked to the Test Quality
 * Reviewer agent, in this order). Bodies are directive markdown appended to the
 * agent's prompt as `### <name>` blocks inside `## Skills / rules`, so they are
 * written straight AT the reviewing model — same conventions as the reviewer
 * prompts in ./seed-prompts.ts. The DB row is the source of truth at run time;
 * editing here only affects freshly seeded workspaces.
 *
 * The 4th demo skill (`flaky-test-patterns`) is deliberately NOT seeded — it
 * ships as the import fixture under `server/test/fixtures/skill-import/` so the
 * import → preview → confirm → link path stays exercisable.
 */

export interface SeedSkill {
  name: string;
  description: string;
  type: 'rubric' | 'convention' | 'security' | 'custom';
  body: string;
}

export const BRANCH_COVERAGE_RUBRIC_BODY = `# Branch coverage rubric

When the diff adds or changes behavior, judge the accompanying tests by the
BRANCHES they exercise — not by line count or test count.

For every changed function, enumerate its decision points (if/else, ternaries,
switch arms, early returns, catch blocks, optional-chaining fallbacks, loop
zero-iteration cases) and check each against the tests in the diff:

- **Untested else/early-return** — a guard or fallback path with no test that
  drives execution through it. Report the exact branch (file + line) and the
  input that would reach it.
- **Missing negative path** — the code can throw or reject (validation failure,
  not-found, permission denied) but every test only asserts the success path.
  A test suite that never asserts a failure mode has NOT tested error handling.
- **Untested boolean combinations** — a condition like \`a && !b\` tested only
  with both true; flag the untested combination that changes the outcome.
- **Catch blocks that swallow** — an added try/catch whose catch path is never
  driven by a test; a bug there ships silently.

Report a finding ONLY when the untested branch can change observable behavior
(wrong result, missed error, wrong status). Do not demand tests for logging,
trivial getters, or branches unreachable from public entry points. In the
rationale name the branch and the concrete input that would cover it; in the
suggestion sketch the missing test case in one or two lines.`;

export const CORNER_CASE_CHECKLIST_BODY = `# Corner-case checklist

For each changed public function, endpoint, or query, walk this checklist and
flag inputs the diff's code or tests visibly mishandle or ignore:

- **Empty & absent** — \`[]\`, \`''\`, \`{}\`, \`null\`, \`undefined\`, missing optional
  fields. Watch the classics: \`0\` and \`''\` are falsy but valid; an empty array
  is truthy; \`??\` vs \`||\` chooses differently for \`0\`/\`''\`/\`false\`.
- **Boundary values** — first/last index, off-by-one at limits, page size 0/1/max,
  exactly-at-limit lengths, min/max integers, negative numbers where only
  positives were considered.
- **Oversized input** — very long strings, huge arrays, deep nesting: is there a
  cap, and does something enforce it before the expensive work happens?
- **Duplicates & ordering** — repeated keys/ids, unstable sort assumptions,
  same-timestamp ties, case-sensitivity mismatches on lookups.
- **Concurrency & repetition** — two identical requests racing (double-insert,
  double-spend), retries of a non-idempotent operation, TOCTOU between a check
  and its use, state mutated between await points.
- **Time & locale** — timezone-dependent parsing, DST edges, epoch vs ISO
  confusion, clock skew in expiry comparisons.

Report ONLY corner cases that are reachable through real inputs of the changed
code and would produce a wrong result, a crash, or corrupted state — cite the
exact file and lines. Skip cases the surrounding code already guards. One
finding per distinct root cause; name the triggering input explicitly.`;

export const MOCK_OVERUSE_GATE_BODY = `# Mock-overuse gate

House rule: a test must exercise the real unit under test. Mocks exist to cut
off EXTERNAL dependencies (network, DB, clock, filesystem) — never to replace
the logic being verified. Flag these patterns in changed test files:

- **Mocking the unit under test** — the module/class the test claims to cover is
  itself stubbed or partially mocked (\`vi.mock\` / \`jest.mock\` of the file under
  test, spying on the method being asserted). The test then verifies the mock,
  not the code. This is the cardinal violation — always report it.
- **Assert-on-mock-only tests** — every assertion is \`toHaveBeenCalledWith\`/
  call-count on mocks, with no assertion on a returned value, thrown error, or
  state change. Such a test restates the implementation and passes even when
  the real logic is wrong.
- **Mirror-the-implementation stubs** — a stub programmed with the exact
  expected output that the assertion then compares against; the test can never
  fail for a real reason.
- **Mocking pure logic** — validators, formatters, price/date calculators
  replaced by stubs. Pure functions are cheap and deterministic; call them.
- **Blanket module mocks** — mocking a whole module to silence one dependency,
  erasing the behavior of everything else it exports.

Acceptable: mocking I/O boundaries (HTTP clients, repositories over a live DB,
message queues, timers via fake clocks) with realistic inputs AND outputs.
When reporting, name the mocked thing, why it hollows out the test, and what
the assertion should target instead (returned value / persisted row / thrown
error). Severity: WARNING by default; SUGGESTION when real assertions exist
alongside the mock noise.`;

export const SEED_SKILLS: SeedSkill[] = [
  {
    name: 'branch-coverage-rubric',
    description:
      'Judge changed tests by the decision branches they exercise; flag untested else-paths and missing negative-path tests in the diff.',
    type: 'rubric',
    body: BRANCH_COVERAGE_RUBRIC_BODY,
  },
  {
    name: 'corner-case-checklist',
    description:
      'Walk boundary values, empty/oversized inputs, duplicates, and concurrency races for every changed function; flag reachable cases the code or tests mishandle.',
    type: 'rubric',
    body: CORNER_CASE_CHECKLIST_BODY,
  },
  {
    name: 'mock-overuse-gate',
    description:
      'Flag tests that mock the unit under test or only assert on mock calls; mocks are for I/O boundaries, assertions belong on real outputs.',
    type: 'convention',
    body: MOCK_OVERUSE_GATE_BODY,
  },
];

export const BREAKING_CHANGE_BODY = `# Breaking-change gate

A contract is PUBLISHED once any consumer outside the diff can call it: a route
path/method, a response field, a request param, an enum value, an error shape.
Treat every change to a published contract as breaking unless it is purely
additive.

Breaking (flag it, name the consumer that fails):
- removing or renaming a route, field, query/path param, or enum value;
- changing a field's type, wire casing, or units;
- making an optional request field required, or narrowing accepted input;
- changing a status code or error shape existing callers branch on.

NOT breaking (do not flag):
- adding a new optional field, param, endpoint, or enum value consumers ignore;
- widening accepted input; adding a new route version alongside the old one.

**Bad** — rename in place; every existing caller's \`pr.head_sha\` is now
\`undefined\`:

\`\`\`ts
// before                          // after
head_sha: z.string(),              headSha: z.string(),
\`\`\`

**Good** — additive: new field ships next to the old one, old one is
deprecated, consumers migrate on their own schedule:

\`\`\`ts
head_sha: z.string(),            // deprecated: use head.sha
head: z.object({ sha: z.string() }),
\`\`\`

Severity: a break in a published contract is CRITICAL — cite the exact
file:line of the change. If you cannot show the contract is published (the only
caller is updated in the same diff), it is at most WARNING.`;

export const RESPONSE_SCHEMA_BODY = `# Response-schema discipline

For every route the diff touches, compare the DECLARED response schema with
what the handler ACTUALLY returns — on the success path and on every error
path. The schema is the contract; the handler must not out-drift it.

Check each changed field for:
- **type drift** — handler returns a number where the schema says string, a
  Date object where the schema says ISO string, an array where an object is
  declared;
- **nullability drift** — handler can return \`null\`/\`undefined\` (failed join,
  optional relation, empty lookup) for a field the schema declares non-nullable;
- **required-ness drift** — a field the schema requires but some code path
  omits, or a schema loosened to \`.optional()\`/\`.nullable()\` only to silence a
  type error while consumers still assume it is always present.

**Bad** — schema promises a non-null string, but the LEFT JOIN can produce
null; consumers doing \`run.agent_name.toLowerCase()\` crash:

\`\`\`ts
agent_name: z.string(),
// handler: agentName: row.agent?.name   ← undefined when the agent was deleted
\`\`\`

**Good** — the schema tells the truth about the join, consumers are forced to
handle the miss:

\`\`\`ts
agent_name: z.string().nullable(),
// handler: agentName: row.agent?.name ?? null
\`\`\`

Severity: drift on a field consumers already read is CRITICAL; drift on a new
or internal field is WARNING. Cite the schema line AND the handler line that
disagree.`;

export const SEMVER_DISCIPLINE_BODY = `# Semver discipline

Classify every API contract change in the diff by the bump it requires, and
flag a mismatch between the change and how the diff signals it:

- **major** — anything the breaking-change gate calls breaking: removal,
  rename, retype, tightened input, changed status/error semantics. Requires an
  explicit versioning signal in the same diff: a bumped package/API version, a
  new versioned route (\`/v2/...\`), or a documented migration path.
- **minor** — additive and backward-compatible: new optional field, new
  endpoint, new enum value, widened input.
- **patch** — behavior-preserving fixes with zero contract surface change.

Flag as a finding:
- a major-class change shipped silently — no version bump, no new route
  version, no migration note anywhere in the diff;
- a "minor-looking" change that is actually major (e.g. a new enum value that
  existing exhaustive \`switch\` consumers will hit as unreachable).

**Bad** — silent major: the param is renamed in place and nothing in the diff
signals a breaking release:

\`\`\`ts
// GET /reviews?pull=…  →  GET /reviews?pr_id=…   (old param now ignored)
\`\`\`

**Good** — the same change as an explicit major: old param still accepted and
mapped, new route version carries the new name:

\`\`\`ts
// /v1: accepts pull (deprecated) and pr_id; /v2: pr_id only
const prId = query.pr_id ?? query.pull;
\`\`\`

Severity: silent major is CRITICAL. A correctly signalled major, or a
misclassified minor with no consumer impact yet, is WARNING. State the required
bump level in every finding.`;

export const DEPRECATION_POLICY_BODY = `# Deprecation policy

An obsolete field, param, or endpoint must go through a deprecation window —
never a silent delete. A correct deprecation in a diff has all three parts:

1. the old surface still WORKS (returns real data / is still routed);
2. it is visibly MARKED deprecated where consumers will see it — schema
   \`.describe('deprecated: …')\`, a \`Deprecation\`/\`Sunset\` header on the route,
   or a doc note in the same diff;
3. the mark names the REPLACEMENT and, where possible, the removal target.

Flag as findings:
- a delete of a public field/param/route with no prior deprecation visible in
  the code or the diff (silent removal);
- a "deprecation" that already breaks consumers: the field now returns \`null\`,
  a stub error, or wrong data while claiming to be merely deprecated;
- a deprecation mark with no replacement named — consumers get a warning but
  no migration path.

**Bad** — field deleted outright; every consumer reading \`score\` breaks today:

\`\`\`ts
- score: z.number(),
+ // removed, use quality_score
\`\`\`

**Good** — old field kept and marked, replacement shipped alongside:

\`\`\`ts
score: z.number().describe('deprecated: use quality_score; removal in v2'),
quality_score: z.number(),
\`\`\`

Severity: silent removal of a used public surface is CRITICAL (it is a
breaking change). A deprecation missing the mark or the named replacement is
WARNING. Cite the removed/changed line and name the replacement the author
should point to.`;

/**
 * L02 follow-up — skills linked to the seeded API Contract Reviewer agent
 * (in this order). Same directive-markdown conventions as SEED_SKILLS above.
 */
export const API_CONTRACT_SEED_SKILLS: SeedSkill[] = [
  {
    name: 'breaking-change',
    description:
      'Flag any change or removal of a published contract — routes, fields, params, enums — as CRITICAL unless a compatible path is provided.',
    type: 'convention',
    body: BREAKING_CHANGE_BODY,
  },
  {
    name: 'response-schema',
    description:
      'Check every changed response against its declared Zod schema: types, nullability, and required-ness must match what the handler actually returns.',
    type: 'convention',
    body: RESPONSE_SCHEMA_BODY,
  },
  {
    name: 'semver-discipline',
    description:
      'Classify every contract change as major/minor/patch; require an explicit major signal (version bump or new route version) for any breaking change.',
    type: 'convention',
    body: SEMVER_DISCIPLINE_BODY,
  },
  {
    name: 'deprecation-policy',
    description:
      'Require a deprecation window instead of silent removal: mark the old surface, keep it functional, and point to the replacement.',
    type: 'convention',
    body: DEPRECATION_POLICY_BODY,
  },
];
