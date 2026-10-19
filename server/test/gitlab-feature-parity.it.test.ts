/**
 * T23 — GitLab feature parity (spec 2026-10-16-gitlab-merge-requests, AC-29 / AC-34).
 *
 * Drives every PR-level feature through `app.inject()` against the T16 GitLab
 * fixture MR (`space-profit/platform/crm-frontend` !5, seeded via
 * `SEED_GITLAB_FIXTURE=1`) and asserts each answers 2xx with a body that
 * round-trips its frozen `@devdigest/shared` contract:
 *
 *   1. POST /pulls/:id/review   — same pipeline steps as a GitHub twin run; the
 *                                 grounding gate drops the hallucinated finding
 *                                 and the score is re-derived (AC-29).
 *   2. GET/POST /pulls/:id/intent
 *   3. POST /pulls/:id/brief
 *   4. GET /pulls/:id/smart-diff — `.gitlab-ci.yml` lands in the wiring group (AC-35)
 *   5. GET /pulls/:id/blast      — over a seeded persistent index
 *   6. POST /findings/:id/eval-case — from the grounded review finding
 *
 * Hermetic: MockGitLabClient / MockGitClient / MockLLMProvider — no network.
 * Extra repos use unique full_names (seed owns `acme/payments-api`, see
 * server/INSIGHTS.md `repos_ws_fullname_uq`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  BlastResponse,
  EvalCaseRecord,
  IntentDetail,
  PrBriefDetail,
  ReviewRecord,
  ReviewRunResponse,
  RunTrace,
  SmartDiffResponse,
  type Review,
} from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { GITLAB_FIXTURE_FULL_NAME } from '../src/db/seed-gitlab.js';
import * as t from '../src/db/schema.js';
import {
  MockEmbedder,
  MockGitClient,
  MockGitHubClient,
  MockGitLabClient,
  MockLLMProvider,
} from '../src/adapters/mocks.js';
import { INDEXER_VERSION } from '../src/modules/repo-intel/constants.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[gitlab-feature-parity] Docker not available — skipping Testcontainers tests.');
}

const FLAG = 'SEED_GITLAB_FIXTURE';

/**
 * The local-clone diff (AC-29: the review diff comes from the clone, not from
 * pr_files). Mirrors the fixture's `src/api/leads.ts` patch: new-side line 2 is
 * the added `import type`, line 4 the rewritten `listLeads` signature.
 */
const LOCAL_DIFF = `diff --git a/src/api/leads.ts b/src/api/leads.ts
--- a/src/api/leads.ts
+++ b/src/api/leads.ts
@@ -1,8 +1,14 @@
 import { http } from './http';
+import type { LeadFilter } from '../types/lead';

-export async function listLeads() {
-  return http.get('/leads');
+export async function listLeads(filter: LeadFilter = {}) {
+  const params = new URLSearchParams();
+  if (filter.status) params.set('status', filter.status);
+  if (filter.ownerId) params.set('owner_id', filter.ownerId);
+  const query = params.toString();
+  return http.get(query ? \`/leads?\${query}\` : '/leads');
 }

 export async function getLead(id: string) {
   return http.get(\`/leads/\${id}\`);
 }`;

/** One grounded finding (leads.ts:4) + one hallucinated one (line 999). */
const REVIEW_FIXTURE: Review = {
  verdict: 'request_changes',
  summary: 'Filter params are not validated.',
  score: 12,
  findings: [
    {
      id: 'gl-valid',
      severity: 'WARNING',
      category: 'bug',
      title: 'Unvalidated lead filter',
      file: 'src/api/leads.ts',
      start_line: 4,
      end_line: 4,
      rationale: 'The filter object is forwarded without validation.',
      suggestion: 'Validate the filter before building the query.',
      confidence: 0.9,
      kind: 'finding',
    },
    {
      id: 'gl-halluc',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Phantom finding outside the diff',
      file: 'src/api/leads.ts',
      start_line: 999,
      end_line: 999,
      rationale: 'This line is not in the diff.',
      confidence: 0.5,
      kind: 'finding',
    },
  ],
};

const INTENT_FIXTURE = {
  summary: 'Add status/owner filters to the CRM leads list.',
  in_scope: ['Lead list filtering'],
  out_of_scope: ['Lead detail page'],
  risk_areas: ['Query-string building in src/api/leads.ts'],
};

const BRIEF_FIXTURE = {
  what: 'Adds status and owner filters to the leads list API and renames ContactCard to LeadCard.',
  why: 'Sales needs to narrow the CRM list view to their own open leads.',
  risks: [
    {
      kind: 'correctness',
      title: 'Unvalidated filter values reach the query string',
      explanation: 'listLeads forwards caller-provided filter values as-is.',
      severity: 'medium',
      refs: [{ path: 'src/api/leads.ts', start_line: 4, end_line: 4 }],
    },
  ],
  review_focus: [{ path: 'src/api/leads.ts', line: 4, reason: 'The new filter signature.' }],
};

/** Normalise a log line to its pipeline step (ids / numbers / quoted / pathy bits stripped). */
function step(msg: string): string {
  return msg
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/`[^`]*`|"[^"]*"|'[^']*'/g, '…')
    .replace(/[\w./@-]*\/[\w./@-]*/g, '…')
    .replace(/#?\d+(\.\d+)?/g, '#')
    .trim();
}

d('GitLab feature parity — fixture MR !5 (Testcontainers pg)', () => {
  let pg: PgFixture;
  let app: FastifyInstance;
  let workspaceId: string;
  let gitlabRepoId: string;
  let prId: string;
  let headSha: string;
  let twinPrId: string;
  let agentId: string;
  const prevFlag = process.env[FLAG];
  const llm = new MockLLMProvider('openai', {
    structured: REVIEW_FIXTURE,
    structuredBySchema: {
      Review: REVIEW_FIXTURE,
      IntentClassification: INTENT_FIXTURE,
      PrBriefGeneration: BRIEF_FIXTURE,
    },
  });
  const gitlab = new MockGitLabClient();
  const git = new MockGitClient({ diff: LOCAL_DIFF });

  beforeAll(async () => {
    pg = await startPg();
    const db = pg.handle.db;
    process.env[FLAG] = '1';
    ({ workspaceId } = await seed(db));

    const [repo] = await db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.provider, 'gitlab'), eq(t.repos.fullName, GITLAB_FIXTURE_FULL_NAME)));
    gitlabRepoId = repo!.id;
    const [mr] = await db
      .select()
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.repoId, gitlabRepoId), eq(t.pullRequests.number, 5)));
    prId = mr!.id;
    headSha = mr!.headSha;

    // The host keeps reporting the fixture head, so nothing re-fetches the detail.
    gitlab.opts.pulls = [
      {
        number: 5,
        title: mr!.title,
        author: mr!.author ?? 'olena.shevchenko',
        branch: mr!.branch ?? 'feat/lead-filters',
        base: mr!.base ?? 'main',
        head_sha: headSha,
        additions: mr!.additions ?? 0,
        deletions: mr!.deletions ?? 0,
        files_count: mr!.filesCount ?? 0,
        stats_known: true,
        is_draft: true,
        status: 'open',
        opened_at: '2026-10-10T09:00:00.000Z',
        updated_at: '2026-10-14T15:30:00.000Z',
      },
    ];

    // AC-35 probe: a GitLab CI config change on the fixture MR.
    await db.insert(t.prFiles).values({
      prId,
      path: '.gitlab-ci.yml',
      additions: 3,
      deletions: 0,
      patch: '@@ -1,2 +1,5 @@\n stages:\n   - test\n+lint:\n+  stage: test\n+  script: pnpm lint',
      changeType: 'modified',
    });

    // Persistent repo-intel index for the GitLab repo (blast radius).
    await db.insert(t.repoIndexState).values({
      repoId: gitlabRepoId,
      lastIndexedSha: headSha,
      indexerVersion: INDEXER_VERSION,
      status: 'full',
      filesIndexed: 12,
      filesSkipped: 0,
    });
    await db.insert(t.symbols).values([
      { repoId: gitlabRepoId, path: 'src/api/leads.ts', name: 'listLeads', kind: 'function', line: 4, endLine: 11, exported: true },
      { repoId: gitlabRepoId, path: 'src/views/LeadsList.vue', name: 'loadLeads', kind: 'function', line: 20, endLine: 40, exported: false },
    ]);
    await db.insert(t.references).values({
      repoId: gitlabRepoId,
      fromPath: 'src/views/LeadsList.vue',
      toSymbol: 'listLeads',
      line: 27,
      declFile: 'src/api/leads.ts',
    });
    await db.insert(t.fileRank).values({
      repoId: gitlabRepoId,
      filePath: 'src/views/LeadsList.vue',
      pagerank: 0.7,
      hotness: 0,
      rank: 0.7,
      percentile: 70,
    });
    await db.insert(t.fileFacts).values({
      repoId: gitlabRepoId,
      filePath: 'src/views/LeadsList.vue',
      endpoints: ['GET /leads'],
      crons: [],
    });

    // GitHub twin PR — same diff, same agent — to compare pipeline steps (AC-29).
    const [twinRepo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'gl-parity-twin', fullName: 'acme/gl-parity-twin' })
      .returning();
    const [twin] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: twinRepo!.id,
        number: 5,
        title: 'Lead filters on the CRM list view',
        author: 'olena.shevchenko',
        branch: 'feat/lead-filters',
        base: 'main',
        headSha: 'twin0001',
        additions: 7,
        deletions: 2,
        filesCount: 1,
        status: 'needs_review',
        body: 'Adds status/owner filters to the leads list.',
      })
      .returning();
    twinPrId = twin!.id;
    await db.insert(t.prFiles).values({
      prId: twinPrId,
      path: 'src/api/leads.ts',
      additions: 7,
      deletions: 2,
      patch: LOCAL_DIFF.split('\n').slice(3).join('\n'),
    });

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      REPO_INTEL_ENABLED: 'true',
    } as NodeJS.ProcessEnv);
    app = await buildApp({
      config,
      db,
      overrides: {
        gitlab,
        github: new MockGitHubClient(),
        git,
        embedder: new MockEmbedder(),
        llm: { openai: llm, openrouter: llm, anthropic: llm },
      },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'GitLab Parity', provider: 'openai', model: 'gpt-4.1', system_prompt: 'review' },
    });
    expect(created.statusCode).toBe(201);
    agentId = created.json().id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
  });

  async function runReview(pullId: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${pullId}/review`,
      payload: { agentId },
    });
    expect(res.statusCode).toBe(200);
    const body = ReviewRunResponse.parse(res.json());
    expect(body.runs).toHaveLength(1);
    const runs = await waitForPrRuns(pg.handle.db, pullId, { expected: 1 });
    const run = runs.find((r) => r.id === body.runs[0]!.run_id)!;
    expect(run.status, run.error ?? '').toBe('done');
    const traceRes = await app.inject({ method: 'GET', url: `/runs/${run.id}/trace` });
    expect(traceRes.statusCode).toBe(200);
    return { run, trace: RunTrace.parse(traceRes.json()) };
  }

  it('1. review: local-clone diff, grounding gate + re-score, same pipeline steps as GitHub (AC-29)', async () => {
    const gl = await runReview(prId);

    // The GitLab MR head ref was fetched from the target project before diffing.
    expect(git.pullHeadFetches.some((f) => f.n === 5)).toBe(true);

    expect(gl.trace.stats.grounding).toBe('1/2 passed');
    expect(gl.run.grounding).toBe('1/2 passed');
    expect(gl.run.findingsCount).toBe(1);

    const reviewsRes = await app.inject({ method: 'GET', url: `/pulls/${prId}/reviews` });
    expect(reviewsRes.statusCode).toBe(200);
    const reviews = ReviewRecord.array().parse(reviewsRes.json());
    const review = reviews.find((r) => r.agent_id === agentId)!;
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({ file: 'src/api/leads.ts', start_line: 4 });
    // Deterministic re-score from the surviving WARNING, not the model's 12.
    expect(review.score).not.toBe(REVIEW_FIXTURE.score);

    const gh = await runReview(twinPrId);
    expect(gh.trace.stats.grounding).toBe('1/2 passed');
    expect(gl.trace.log.map((l) => step(l.msg))).toEqual(gh.trace.log.map((l) => step(l.msg)));
    expect(gl.trace.log.map((l) => l.kind)).toEqual(gh.trace.log.map((l) => l.kind));
  });

  it('2. intent: POST classifies, GET round-trips the same IntentDetail', async () => {
    const post = await app.inject({ method: 'POST', url: `/pulls/${prId}/intent` });
    expect(post.statusCode).toBe(200);
    const created = IntentDetail.parse(post.json());
    expect(created).toMatchObject({
      pr_id: prId,
      intent: INTENT_FIXTURE.summary,
      in_scope: INTENT_FIXTURE.in_scope,
      head_sha: headSha,
      stale: false,
    });

    const get = await app.inject({ method: 'GET', url: `/pulls/${prId}/intent` });
    expect(get.statusCode).toBe(200);
    expect(IntentDetail.parse(get.json())).toEqual(created);
  });

  it('3. brief: POST generates a grounded PrBriefDetail', async () => {
    const res = await app.inject({ method: 'POST', url: `/pulls/${prId}/brief` });
    expect(res.statusCode).toBe(200);
    const body = PrBriefDetail.parse(res.json());
    expect(body.pr_id).toBe(prId);
    expect(body.generation).toEqual({ state: 'ok', reason: null });
    expect(body.what).toBe(BRIEF_FIXTURE.what);
    expect(body.risks).toHaveLength(1);
    expect(body.review_focus).toEqual([
      expect.objectContaining({ path: 'src/api/leads.ts', line: 4 }),
    ]);
    expect(body.head_sha).toBe(headSha);
  });

  it('4. smart-diff: GitLab files grouped; .gitlab-ci.yml is wiring (AC-35)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/smart-diff` });
    expect(res.statusCode).toBe(200);
    const body = SmartDiffResponse.parse(res.json());
    const roleOf = (path: string) =>
      body.groups.find((g) => g.files.some((f) => f.path === path))?.role;
    expect(roleOf('.gitlab-ci.yml')).toBe('wiring');
    expect(roleOf('src/api/leads.ts')).toBe('core');
    expect(roleOf('package-lock.json')).toBe('boilerplate');
    const allPaths = body.groups.flatMap((g) => g.files.map((f) => f.path)).sort();
    expect(allPaths).toEqual(
      ['.gitlab-ci.yml', 'package-lock.json', 'src/api/leads.ts', 'src/components/LeadCard.vue'].sort(),
    );
  });

  it('5. blast: callers / endpoints from the persistent index', async () => {
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/blast` });
    expect(res.statusCode).toBe(200);
    const body = BlastResponse.parse(res.json());
    expect(body.status).toBe('ok');
    const sym = body.symbols.find((s) => s.symbol.name === 'listLeads')!;
    expect(sym).toBeDefined();
    expect(sym.symbol.file).toBe('src/api/leads.ts');
    expect(sym.callers).toEqual([
      expect.objectContaining({ file: 'src/views/LeadsList.vue', line: 27 }),
    ]);
    expect(sym.endpoints_affected).toEqual(['GET /leads']);
  });

  it('6. eval case: created from the grounded GitLab finding (201, then idempotent 200)', async () => {
    const reviews = ReviewRecord.array().parse(
      (await app.inject({ method: 'GET', url: `/pulls/${prId}/reviews` })).json(),
    );
    const finding = reviews.find((r) => r.agent_id === agentId)!.findings[0]!;
    const accept = await app.inject({ method: 'POST', url: `/findings/${finding.id}/accept` });
    expect(accept.statusCode).toBe(200);

    const first = await app.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    expect(first.statusCode, first.body).toBe(201);
    const created = EvalCaseRecord.parse(first.json());
    expect(created).toMatchObject({ owner_kind: 'agent', owner_id: agentId, source_finding_id: finding.id });
    expect(created.input_diff).toContain('diff --git a/src/api/leads.ts b/src/api/leads.ts');
    expect(created.expected_output).toMatchObject({
      kind: 'must_find',
      expectations: [{ file: 'src/api/leads.ts', start_line: 4, end_line: 4 }],
    });

    const again = await app.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(created.id);
  });
});
