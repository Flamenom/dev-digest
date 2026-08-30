import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { Finding, GitClient, RunTrace } from '@devdigest/shared';
import { ReviewRunExecutor } from '../src/modules/reviews/run-executor.js';
import type { ReviewRepository, PullRow, ReviewRow, FindingRow } from '../src/modules/reviews/repository.js';
import type { AgentRow } from '../src/db/rows.js';
import type { Container } from '../src/platform/container.js';
import type * as schema from '../src/db/schema.js';
import { RunBus } from '../src/platform/sse.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';

/**
 * Hermetic run-executor tests for project-context injection (AC-18/AC-19/
 * AC-21/AC-22/AC-23/AC-24/AC-26 + the AC-35 grounding companion). Everything
 * is faked at the port level: MockLLMProvider (captures the assembled prompt),
 * a temp working tree behind a paths-only GitClient fake, a recording
 * ReviewRepository fake, and the real in-memory RunBus. No DB, no network.
 */

// ---------------------------------------------------------------- fixtures

const RUN_ID = 'run-1';
const WS = 'ws-1';

// One changed file, new-side hunk lines 10..13 (added line 11) — the grounded
// finding below cites line 11; the hallucinated one cites line 400.
const DIFF_RAW = [
  'diff --git a/src/config.ts b/src/config.ts',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -10,3 +10,4 @@',
  '   port: 3000,',
  '+  stripeKey: "sk_live_xxx",',
  '   redisUrl: x,',
].join('\n');

const GROUNDED_FINDING: Finding = {
  id: 'f-grounded',
  severity: 'CRITICAL',
  category: 'security',
  title: 'Live key committed — violates the attached spec invariant',
  file: 'src/config.ts',
  start_line: 11,
  end_line: 11,
  rationale: 'The spec invariant "never commit live keys" is violated by stripeKey.',
  suggestion: 'Move the key to an env var.',
  confidence: 0.95,
};

const HALLUCINATED_FINDING: Finding = {
  id: 'f-hallucinated',
  severity: 'WARNING',
  category: 'bug',
  title: 'Made-up issue on a line outside every hunk',
  file: 'src/config.ts',
  start_line: 400,
  end_line: 400,
  rationale: 'This location does not exist in the diff.',
  suggestion: null,
  confidence: 0.5,
};

const REVIEW_FIXTURE = {
  verdict: 'request_changes',
  summary: 'One real problem, one hallucination.',
  score: 35,
  findings: [GROUNDED_FINDING, HALLUCINATED_FINDING],
};

function pullRow(): PullRow {
  return {
    id: 'pr-uuid-1',
    workspaceId: WS,
    repoId: 'repo-uuid-1',
    number: 482,
    title: 'Add rate limiting',
    author: 'marisa.koch',
    branch: 'feat/rate-limit',
    base: 'main',
    headSha: 'a1b2c3d4',
    lastReviewedSha: null,
    additions: 4,
    deletions: 0,
    filesCount: 1,
    status: 'needs_review',
    body: null,
    openedAt: null,
    updatedAt: null,
  } as PullRow;
}

function repoRow(): typeof schema.repos.$inferSelect {
  return {
    id: 'repo-uuid-1',
    workspaceId: WS,
    owner: 'acme',
    name: 'widgets',
    fullName: 'acme/widgets',
    defaultBranch: 'main',
    clonePath: null,
    lastPolledAt: null,
    createdBy: null,
    createdAt: new Date('2026-08-18T00:00:00Z'),
  } as typeof schema.repos.$inferSelect;
}

function agentRow(attachedDocPaths: string[]): AgentRow {
  return {
    id: 'agent-uuid-1',
    workspaceId: WS,
    name: 'Security Reviewer',
    description: '',
    provider: 'openai',
    model: 'gpt-4.1',
    systemPrompt: 'You are a security reviewer.',
    outputSchema: null,
    strategy: 'single-pass',
    ciFailOn: 'critical',
    repoIntel: false, // opt out of repo-intel so no facade is needed
    attachedDocPaths,
    enabled: true,
    version: 1,
    createdBy: null,
    createdAt: new Date('2026-08-18T00:00:00Z'),
  } as AgentRow;
}

// -------------------------------------------------------------- test rig

type SkillFixture = { name: string; body: string; enabled: boolean; attachedDocPaths: string[] };

interface Scenario {
  trace: RunTrace;
  prompt: string;
  llm: MockLLMProvider;
  completed: Record<string, unknown>;
  insertedFindings: Finding[];
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Run ONE agent review end-to-end through ReviewRunExecutor against a temp
 * clone containing `cloneFiles`, returning the persisted trace + the exact
 * user prompt the (mock) provider saw.
 */
async function runScenario(opts: {
  agentDocPaths: string[];
  skills?: SkillFixture[];
  cloneFiles?: Record<string, string>;
}): Promise<Scenario> {
  const clone = await mkdtemp(path.join(os.tmpdir(), 'pc-executor-'));
  tempDirs.push(clone);
  for (const [rel, body] of Object.entries(opts.cloneFiles ?? {})) {
    const abs = path.join(clone, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }

  const llm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });

  // Port-level GitClient fake: paths + diff only (loadDiff calls git.diff;
  // readDocument calls git.clonePathFor — never git.readFile).
  const git = {
    clonePathFor: () => clone,
    diff: async () => parseUnifiedDiff(DIFF_RAW),
  } as unknown as GitClient;

  const traces: Record<string, RunTrace> = {};
  const completed: Record<string, unknown> = {};
  const insertedFindings: Finding[] = [];
  const repoFake = {
    getPrFiles: async () => [],
    insertReview: async (values: Record<string, unknown>) =>
      ({ ...values, id: 'review-1' }) as unknown as ReviewRow,
    insertFindings: async (_reviewId: string, findings: Finding[]) => {
      insertedFindings.push(...findings);
      return findings.map((f, i) => ({ ...f, id: `row-${i}` })) as unknown as FindingRow[];
    },
    markReviewed: async () => undefined,
    completeAgentRun: async (runId: string, values: unknown) => {
      completed[runId] = values;
    },
    saveRunTrace: async (runId: string, trace: RunTrace) => {
      traces[runId] = trace;
    },
  } as unknown as ReviewRepository;

  const container = {
    runBus: new RunBus(),
    git,
    llm: async () => llm,
    intent: {
      // Intent is best-effort shared pre-work — reject so the prompt shape
      // under test stays the plain (no-intent) one.
      getOrDeriveFresh: async () => {
        throw new Error('intent disabled in this test');
      },
    },
    skillsRepo: {
      resolveAgentSkills: async () => opts.skills ?? [],
    },
  } as unknown as Container;

  const executor = new ReviewRunExecutor(container, repoFake, {} as Container['agentsRepo']);
  await executor.executeRuns(WS, pullRow(), repoRow(), [
    { agent: agentRow(opts.agentDocPaths), runId: RUN_ID },
  ]);

  const structuredCalls = llm.calls.filter((c) => c.method === 'completeStructured');
  const lastReq = structuredCalls.at(-1)?.req as
    | { messages: { role: string; content: string }[] }
    | undefined;
  const prompt = lastReq?.messages.find((m) => m.role === 'user')?.content ?? '';

  const trace = traces[RUN_ID];
  if (!trace) throw new Error('run trace was not persisted');
  return { trace, prompt, llm, completed, insertedFindings };
}

const AGENT_DOC = 'AGENT DOC — invariant: never commit live keys.';
const SKILL_DOC = 'SKILL DOC — rate limits must be configurable.';
const DISABLED_DOC = 'DISABLED DOC — must never reach the prompt.';

// ------------------------------------------------------------------ tests

describe('ReviewRunExecutor project-context injection', () => {
  it('injects agent + enabled-skill docs, deduped in deterministic order, untrusted-fenced (AC-18/AC-19/AC-21/AC-20)', async () => {
    const { trace, prompt, completed, insertedFindings } = await runScenario({
      agentDocPaths: ['docs/agent.md'],
      skills: [
        {
          name: 'rate-limit-rules',
          body: 'skill body',
          enabled: true,
          // 'docs/agent.md' duplicates the agent's path → deduped, first wins.
          attachedDocPaths: ['docs/skill.md', 'docs/agent.md'],
        },
        {
          name: 'disabled-skill',
          body: 'disabled body',
          enabled: false,
          attachedDocPaths: ['docs/disabled.md'], // must NOT contribute (AC-18)
        },
      ],
      cloneFiles: {
        'docs/agent.md': AGENT_DOC,
        'docs/skill.md': SKILL_DOC,
        'docs/disabled.md': DISABLED_DOC,
      },
    });

    // Trace: both read, deduped, agent-first order; nothing missing (AC-26).
    expect(trace.specs_read).toEqual(['docs/agent.md', 'docs/skill.md']);
    expect(trace.specs_missing).toEqual([]);

    // Prompt: a `## Project context` section with each doc in its own
    // untrusted fence (reviewer-core wrapUntrusted markers), agent doc first.
    expect(prompt).toContain('## Project context');
    expect(prompt).toContain(`<untrusted source="spec-0">\n${AGENT_DOC}\n</untrusted>`);
    expect(prompt).toContain(`<untrusted source="spec-1">\n${SKILL_DOC}\n</untrusted>`);
    expect(prompt.indexOf(AGENT_DOC)).toBeLessThan(prompt.indexOf(SKILL_DOC));
    expect(prompt).not.toContain(DISABLED_DOC);

    // AC-35 companion: the grounded finding that cites the spec's invariant
    // survives the grounding gate; the hallucinated one is dropped.
    expect(insertedFindings.map((f) => f.id)).toEqual([GROUNDED_FINDING.id]);
    expect(completed[RUN_ID]).toMatchObject({
      status: 'done',
      grounding: '1/2 passed',
      findingsCount: 1,
    });
  });

  it('skips a stale path fail-soft: survivors injected, stale path in specs_missing distinct from specs_read (AC-22/AC-26)', async () => {
    const { trace, prompt, completed } = await runScenario({
      agentDocPaths: ['docs/agent.md', 'docs/ghost.md'], // ghost never written
      cloneFiles: { 'docs/agent.md': AGENT_DOC },
    });

    expect(trace.specs_read).toEqual(['docs/agent.md']);
    expect(trace.specs_missing).toEqual(['docs/ghost.md']);
    // The two lists never overlap.
    expect(trace.specs_read.filter((p) => trace.specs_missing.includes(p))).toEqual([]);

    // Survivor still injected; the run completes normally.
    expect(prompt).toContain(AGENT_DOC);
    expect(completed[RUN_ID]).toMatchObject({ status: 'done' });
  });

  it('a guard-refused (traversal) path lands in specs_missing, never in the prompt (AC-22/AC-30)', async () => {
    const { trace, prompt } = await runScenario({
      agentDocPaths: ['../../etc/passwd', 'docs/agent.md'],
      cloneFiles: { 'docs/agent.md': AGENT_DOC },
    });

    expect(trace.specs_missing).toEqual(['../../etc/passwd']);
    expect(trace.specs_read).toEqual(['docs/agent.md']);
    expect(prompt).not.toContain('passwd');
    expect(prompt).toContain(AGENT_DOC);
  });

  it('zero attached docs → NO `## Project context` section and specs_read: [] (AC-23)', async () => {
    const { trace, prompt, completed } = await runScenario({ agentDocPaths: [] });

    expect(prompt).not.toContain('## Project context');
    expect(prompt).not.toContain('<untrusted source="spec-');
    expect(trace.specs_read).toEqual([]);
    expect(trace.specs_missing).toEqual([]);
    expect(completed[RUN_ID]).toMatchObject({ status: 'done' });
  });

  it('injection adds ZERO extra provider calls: call count identical with and without docs (AC-24)', async () => {
    const withDocs = await runScenario({
      agentDocPaths: ['docs/agent.md'],
      cloneFiles: { 'docs/agent.md': AGENT_DOC },
    });
    const withoutDocs = await runScenario({ agentDocPaths: [] });

    const structured = (s: Scenario) =>
      s.llm.calls.filter((c) => c.method === 'completeStructured').length;

    expect(structured(withDocs)).toBe(1); // single-pass → exactly one LLM call
    expect(structured(withDocs)).toBe(structured(withoutDocs));
    // No embedding / completion side-calls are made for injection either.
    expect(withDocs.llm.calls.map((c) => c.method)).toEqual(
      withoutDocs.llm.calls.map((c) => c.method),
    );
  });
});
