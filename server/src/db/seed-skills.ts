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
