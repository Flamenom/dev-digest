import { describe, it, expect, vi } from 'vitest';
import type { IntentDetailWrite, RepoRef, StoredIntentDetail } from '@devdigest/shared';
import {
  deriveIntent,
  getOrDeriveIntentFresh,
  type IntentDeriverDeps,
  type IntentPull,
} from '../src/modules/reviews/intent-deriver.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * Hermetic tests for the L03 intent deriver free functions (no DB, no network):
 * deterministic confidence, honest `unavailable` source marking (missing repo
 * doc / external URL — never fabricated), the hunk-headers-only prompt
 * projection (diff bodies never reach the classifier), the no-source-bodies
 * structured log line, and the getOrDeriveIntentFresh head_sha short-circuit.
 *
 * NOTE (server/INSIGHTS.md): the shared MockGitClient.readFile returns '' for
 * missing files — the deriver's "throw ⇒ unavailable" semantics require a
 * custom fake GitClient that THROWS, so we inject one here.
 */

const PR_ID = 'pr-1';
const HEAD_SHA = 'head-sha-1';

const CLASSIFICATION_FIXTURE = {
  summary: 'Introduce per-IP rate limiting on the public API endpoints.',
  in_scope: ['Token-bucket middleware', 'Redis-backed counters'],
  out_of_scope: ['Auth changes', 'Admin endpoints'],
  risk_areas: ['Auth surface touched', 'New dependency: ioredis'],
};

// Patch with body lines (incl. a fake secret) and a hunk header carrying a
// trailing code fragment — only the bare `@@ …@@` part may reach the LLM.
const PATCH =
  '@@ -10,3 +10,4 @@ function buildConfig()\n' +
  '   port: 3000,\n' +
  '+  stripeKey: "sk_live_leak_me_not",\n' +
  '   redisUrl: x,';

interface DepsOptions {
  body?: string | null;
  files?: { path: string; patch: string | null }[];
  /** Repo docs present in the fake clone; anything else THROWS (file absent). */
  docs?: Record<string, string>;
  /** getIssue behavior: an issue payload, or 'fail' to reject. */
  issue?: { title: string; body: string | null } | 'fail';
  /** Pre-stored intent row (for getOrDeriveIntentFresh short-circuit). */
  stored?: StoredIntentDetail;
}

function makeDeps(opts: DepsOptions = {}) {
  const pull: IntentPull = {
    id: PR_ID,
    repoId: 'repo-1',
    number: 482,
    title: 'Add rate limiting to public API endpoints',
    author: 'marisa.koch',
    branch: 'feat/rate-limit-public',
    base: 'main',
    headSha: HEAD_SHA,
    body: opts.body ?? null,
  };

  let saved: IntentDetailWrite | undefined;
  let stored: StoredIntentDetail | undefined = opts.stored;

  const getIssue = vi.fn(async (_repo: RepoRef, n: number) => {
    if (opts.issue === 'fail' || !opts.issue) throw new Error('GitHub unavailable');
    return { number: n, title: opts.issue.title, body: opts.issue.body, state: 'open' };
  });

  const readFile = vi.fn(async (_repo: RepoRef, path: string) => {
    const content = opts.docs?.[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  });

  const llm = new MockLLMProvider('openai', {
    structuredBySchema: { IntentClassification: CLASSIFICATION_FIXTURE },
  });

  const repo: IntentDeriverDeps['repo'] = {
    getPull: vi.fn(async () => pull),
    getRepo: vi.fn(async () => ({ owner: 'acme', name: 'payments-api' })),
    getPrFiles: vi.fn(async () => opts.files ?? []),
    upsertIntentDetail: vi.fn(async (_prId, input) => {
      saved = input;
      stored = {
        pr_id: PR_ID,
        intent: input.intent,
        in_scope: input.in_scope,
        out_of_scope: input.out_of_scope,
        risk_areas: input.risk_areas,
        confidence: input.confidence,
        sources: input.sources,
        model: input.model ?? null,
        head_sha: input.head_sha ?? null,
        generated_at: '2026-08-21T00:00:00.000Z',
      };
    }),
    getIntentDetail: vi.fn(async () => stored),
  };

  const deps: IntentDeriverDeps = {
    repo,
    github: async () => ({ getIssue }),
    git: { readFile },
    llm: async () => llm,
    resolveModel: async () => ({ provider: 'openai', model: 'test-intent-model' }),
  };

  return {
    deps,
    pull,
    llm,
    repo,
    getIssue,
    readFile,
    savedWrite: () => saved,
  };
}

/** The single user message sent to the classifier. */
function userMessageOf(llm: MockLLMProvider): string {
  const call = llm.calls.find((c) => c.method === 'completeStructured');
  expect(call).toBeDefined();
  const messages = (call!.req as { messages: { role: string; content: string }[] }).messages;
  return messages.find((m) => m.role === 'user')!.content;
}

describe('deriveIntent — sources & confidence', () => {
  it('empty PR body → no sources, deterministic low confidence', async () => {
    const { deps,savedWrite } = makeDeps({ body: null });

    const detail = await deriveIntent(deps, 'ws-1', PR_ID);

    expect(detail.confidence).toBe('low');
    expect(detail.sources).toEqual([]);
    expect(detail.intent).toBe(CLASSIFICATION_FIXTURE.summary);
    expect(detail.stale).toBe(false);
    expect(savedWrite()).toMatchObject({ confidence: 'low', head_sha: HEAD_SHA });
  });

  it('missing repo doc (fake git THROWS) → unavailable source + low confidence; present doc is fetched', async () => {
    const { deps,readFile } = makeDeps({
      body: 'Implements specs/04-intent-layer.md; see also docs/missing.md.',
      docs: { 'specs/04-intent-layer.md': '# Intent Layer spec\nClassifier details.' },
    });

    const detail = await deriveIntent(deps, 'ws-1', PR_ID);

    expect(detail.sources).toContainEqual({
      kind: 'repo_doc',
      ref: 'specs/04-intent-layer.md',
      status: 'fetched',
    });
    expect(detail.sources).toContainEqual({
      kind: 'repo_doc',
      ref: 'docs/missing.md',
      status: 'unavailable',
    });
    // ANY unavailable source forces low confidence, even with fetched ones present.
    expect(detail.confidence).toBe('low');
    expect(readFile).toHaveBeenCalledWith(
      { owner: 'acme', name: 'payments-api' },
      'docs/missing.md',
    );
  });

  it('linked issue fetched via the GitHub adapter → fetched source + high confidence', async () => {
    const { deps,getIssue } = makeDeps({
      body: 'Adds a limiter to the public API. Fixes #471.',
      issue: { title: 'Rate limit the public API', body: 'Please add per-IP limits.' },
    });

    const detail = await deriveIntent(deps, 'ws-1', PR_ID);

    expect(getIssue).toHaveBeenCalledWith({ owner: 'acme', name: 'payments-api' }, 471);
    expect(detail.sources).toContainEqual({
      kind: 'pr_description',
      ref: 'PR description',
      status: 'fetched',
    });
    expect(detail.sources).toContainEqual({
      kind: 'linked_issue',
      ref: '#471',
      title: 'Rate limit the public API',
      status: 'fetched',
    });
    expect(detail.confidence).toBe('high');
  });

  it('linked issue fetch failure → unavailable source, never fabricated', async () => {
    const { deps,llm } = makeDeps({
      body: 'Closes #99.',
      issue: 'fail',
    });

    const detail = await deriveIntent(deps, 'ws-1', PR_ID);

    expect(detail.sources).toContainEqual({ kind: 'linked_issue', ref: '#99', status: 'unavailable' });
    expect(detail.confidence).toBe('low');
    // No issue content exists, so no "## Linked issue" block reaches the LLM.
    expect(userMessageOf(llm)).not.toContain('## Linked issue');
  });

  it('external URL → unavailable source; content never fetched, listed as NOT-fetched only', async () => {
    const url = 'https://example.com/design-doc';
    const { deps,llm } = makeDeps({
      body: `Implements the design at ${url}. Details: ${url}.`,
    });

    const detail = await deriveIntent(deps, 'ws-1', PR_ID);

    // Deduped to one source, always unavailable (v1 locked decision).
    const external = detail.sources.filter((s) => s.kind === 'external_url');
    expect(external).toEqual([{ kind: 'external_url', ref: url, status: 'unavailable' }]);
    expect(detail.confidence).toBe('low');

    // The prompt only ever lists the URL under the explicit NOT-fetched marker.
    const user = userMessageOf(llm);
    expect(user).toContain('NOT fetched — content unavailable');
    expect(user).toContain(`- ${url}`);
  });
});

describe('deriveIntent — prompt projection & observability', () => {
  it('LLM messages carry file paths + bare `@@ …@@` hunk headers, never patch bodies', async () => {
    const { deps,llm } = makeDeps({
      body: 'Adds rate limiting.',
      files: [
        { path: 'src/config.ts', patch: PATCH },
        { path: 'src/middleware/ratelimit.ts', patch: null },
      ],
    });

    await deriveIntent(deps, 'ws-1', PR_ID);

    const user = userMessageOf(llm);
    expect(user).toContain('src/config.ts');
    expect(user).toContain('src/middleware/ratelimit.ts'); // empty patch → path only
    expect(user).toContain('@@ -10,3 +10,4 @@');
    // Patch BODY lines never reach the classifier…
    expect(user).not.toContain('sk_live_leak_me_not');
    expect(user).not.toContain('port: 3000');
    expect(user).not.toContain('redisUrl');
    // …and neither does the hunk header's trailing code fragment.
    expect(user).not.toContain('function buildConfig()');
  });

  it('the structured log line carries section names/sizes + source statuses, never source bodies', async () => {
    const issueBody = 'SECRET-ISSUE-BODY: please add per-IP limits.';
    const docContent = 'SECRET-DOC-CONTENT: classifier details.';
    const prBody = 'Adds a limiter. Fixes #471. See specs/04-intent-layer.md.';
    const logs: unknown[] = [];
    const { deps } = makeDeps({
      body: prBody,
      issue: { title: 'Rate limit the public API', body: issueBody },
      docs: { 'specs/04-intent-layer.md': docContent },
      files: [{ path: 'src/config.ts', patch: PATCH }],
    });

    await deriveIntent(deps, 'ws-1', PR_ID, { info: (obj) => logs.push(obj) });

    expect(logs).toHaveLength(1);
    const line = logs[0] as {
      feature: string;
      provider: string;
      model: string;
      promptSections: { name: string; chars: number }[];
      tokenEstimate: number;
      sources: { kind: string; ref: string; status: string }[];
    };
    expect(line.feature).toBe('intent');
    expect(line.provider).toBe('openai');
    expect(line.model).toBe('test-intent-model');
    expect(line.promptSections.map((s) => s.name)).toEqual(
      expect.arrayContaining(['pr-meta', 'pr-description', 'linked-issue', 'changed-files']),
    );
    expect(line.tokenEstimate).toBeGreaterThan(0);
    expect(line.sources).toContainEqual({ kind: 'linked_issue', ref: '#471', status: 'fetched' });

    // The serialized line must contain NO source bodies, diff content, or PR body.
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain(issueBody);
    expect(serialized).not.toContain(docContent);
    expect(serialized).not.toContain(prBody);
    expect(serialized).not.toContain('sk_live_leak_me_not');
  });
});

describe('getOrDeriveIntentFresh — head_sha short-circuit', () => {
  const STORED: StoredIntentDetail = {
    pr_id: PR_ID,
    intent: 'Stored intent summary',
    in_scope: ['a'],
    out_of_scope: ['b'],
    risk_areas: [],
    confidence: 'high',
    sources: [{ kind: 'pr_description', ref: 'PR description', status: 'fetched' }],
    model: 'test-intent-model',
    head_sha: HEAD_SHA,
    generated_at: '2026-08-20T00:00:00.000Z',
  };

  it('matching head_sha → returns the stored intent WITHOUT an LLM call', async () => {
    const { deps,pull, llm } = makeDeps({ body: 'Adds a limiter.', stored: STORED });

    const detail = await getOrDeriveIntentFresh(deps, 'ws-1', pull);

    expect(detail.intent).toBe('Stored intent summary');
    expect(detail.stale).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it('head_sha mismatch → re-classifies inline (one LLM call, fresh head_sha persisted)', async () => {
    const { deps,pull, llm, savedWrite } = makeDeps({
      body: 'Adds a limiter.',
      stored: { ...STORED, head_sha: 'older-sha' },
    });

    const detail = await getOrDeriveIntentFresh(deps, 'ws-1', pull);

    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);
    expect(detail.intent).toBe(CLASSIFICATION_FIXTURE.summary);
    expect(savedWrite()).toMatchObject({ head_sha: HEAD_SHA });
    expect(detail.stale).toBe(false);
  });
});
