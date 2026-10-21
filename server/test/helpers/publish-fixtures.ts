import type { FastifyInstance } from 'fastify';
import type { Publication } from '@devdigest/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/platform/config.js';
import type { Db } from '../../src/db/client.js';
import * as t from '../../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockSecretsProvider } from '../../src/adapters/mocks.js';
import { FakeGitLab } from './fake-gitlab.js';
import type { PgFixture } from './pg.js';

/**
 * Fixtures for the publish-to-GitLab integration suites (spec
 * 2026-10-21-gitlab-publish-findings, plan T11): a seeded GitLab repo / MR row
 * with a persisted diff (`pr_files`, `detail_head_sha` = the reviewed head), one
 * or more reviews with findings, and the matching MR on a `FakeGitLab`.
 *
 * Default diff + findings cover every anchor kind, in send order
 * (severity → file → line):
 *   1. `multi`   CRITICAL  src/main.ts 2–4  → multi_line (all added lines)
 *   2. `single`  WARNING   src/main.ts 5    → single_line (context line: old 3 / new 5)
 *   3. `withheld` SUGGESTION src/huge.ts 3  → general, patch_unavailable
 *   4. `offdiff` SUGGESTION src/main.ts 40–41 → general, not_on_diff_line
 */

export const PUB_TOKEN = 'glpat-publishSecretToken00000001';
export const SERVICE_ACCOUNT = 'devdigest-bot';
export const PUB_HEAD = 'pubhead1111';
export const PUB_IID = 5;

/** ctx 1/1 · removed old 2 · added new 2,3,4 · ctx old 3/new 5 · ctx old 4/new 6 */
export const MAIN_PATCH =
  '@@ -1,4 +1,6 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n+const d = 5;\n const e = 6;\n const f = 7;';

/**
 * Finding text an attacker could shape (via the reviewed code): quick actions,
 * mentions, references and auto-loading images (AC-15, AC-16). The inline code
 * span must survive untouched.
 */
export const HOSTILE_TEXT = [
  '/close',
  '/merge',
  '@all see #12 and !45, ~bug %v1 and group/project#7.',
  '![pixel](https://evil.example/p.png) <img src="https://evil.example/i.png">',
  'Code stays: `@keep #1`',
].join('\n');

export interface FindingSeed {
  key: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: 'CRITICAL' | 'WARNING' | 'SUGGESTION';
  category?: 'bug' | 'security' | 'perf' | 'style' | 'test';
  title?: string;
  rationale?: string;
  suggestion?: string | null;
  kind?: 'finding' | 'secret_leak' | 'lethal_trifecta' | 'phantom' | 'hook';
  dismissed?: boolean;
}

export const DEFAULT_FINDINGS: readonly FindingSeed[] = [
  {
    key: 'multi',
    file: 'src/main.ts',
    startLine: 2,
    endLine: 4,
    severity: 'CRITICAL',
    title: 'Unchecked import @all #12',
    rationale: HOSTILE_TEXT,
    suggestion: '```ts\nconst b = 30;\nconst c = 40;\nconst d = 50;\n```',
  },
  { key: 'single', file: 'src/main.ts', startLine: 5, endLine: 5, severity: 'WARNING', title: 'Context line finding' },
  { key: 'withheld', file: 'src/huge.ts', startLine: 3, endLine: 3, severity: 'SUGGESTION', title: 'Withheld patch' },
  { key: 'offdiff', file: 'src/main.ts', startLine: 40, endLine: 41, severity: 'SUGGESTION', title: 'Off the diff' },
];

export interface SeedPublishOptions {
  workspaceId: string;
  /** GitLab `group/…/project` path; also the repo `full_name`. Unique per test. */
  fullPath: string;
  iid?: number;
  provider?: 'gitlab' | 'github';
  /** PR head (`pull_requests.head_sha`); default `PUB_HEAD`. */
  prHead?: string;
  /** `detail_head_sha`; default = `prHead`. */
  detailHead?: string | null;
  /** Each review's `head_sha`; default = `prHead`; null ⇒ pre-AC-1 review. */
  reviewHead?: string | null;
  status?: 'open' | 'merged' | 'closed';
  findings?: readonly FindingSeed[];
  /** Reviews to create, each with the same findings. Default 1. */
  reviews?: number;
}

export interface SeededPublishPr {
  repoId: string;
  prId: string;
  reviewIds: string[];
  /** First review. */
  reviewId: string;
  /** Finding ids per review, in seed order. */
  findingIds: string[][];
  /** First review's finding id by seed key. */
  ids: Record<string, string>;
}

/** A GitLab repo + MR row + persisted diff + review(s) with findings. */
export async function seedPublishPr(db: Db, opts: SeedPublishOptions): Promise<SeededPublishPr> {
  const prHead = opts.prHead ?? PUB_HEAD;
  const provider = opts.provider ?? 'gitlab';
  const [owner, ...rest] = opts.fullPath.split('/');
  const [repo] = await db
    .insert(t.repos)
    .values({
      workspaceId: opts.workspaceId,
      owner: owner!,
      name: rest.join('/') || owner!,
      fullName: opts.fullPath,
      provider,
      ...(provider === 'gitlab' ? { host: 'gitlab.com' } : {}),
    })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId: opts.workspaceId,
      repoId: repo!.id,
      number: opts.iid ?? PUB_IID,
      title: 'Publish findings MR',
      author: 'olena.dev',
      branch: 'feat/publish',
      base: 'main',
      headSha: prHead,
      detailHeadSha: opts.detailHead === undefined ? prHead : opts.detailHead,
      status: opts.status ?? 'open',
    })
    .returning();
  await db.insert(t.prFiles).values([
    { prId: pr!.id, path: 'src/main.ts', additions: 3, deletions: 1, patch: MAIN_PATCH },
    { prId: pr!.id, path: 'src/huge.ts', additions: 900, patch: null, patchOmitted: 'too_large' },
  ]);

  const findings = opts.findings ?? DEFAULT_FINDINGS;
  const reviewIds: string[] = [];
  const findingIds: string[][] = [];
  for (let i = 0; i < (opts.reviews ?? 1); i++) {
    const [review] = await db
      .insert(t.reviews)
      .values({
        workspaceId: opts.workspaceId,
        prId: pr!.id,
        kind: 'review',
        headSha: opts.reviewHead === undefined ? prHead : opts.reviewHead,
      })
      .returning();
    reviewIds.push(review!.id);
    const rows =
      findings.length === 0
        ? []
        : await db
            .insert(t.findings)
            .values(
              findings.map((f) => ({
                reviewId: review!.id,
                file: f.file,
                startLine: f.startLine,
                endLine: f.endLine,
                severity: f.severity,
                category: f.category ?? 'bug',
                title: f.title ?? `Finding ${f.key}`,
                rationale: f.rationale ?? `Rationale of ${f.key}.`,
                suggestion: f.suggestion ?? null,
                confidence: 0.9,
                kind: f.kind ?? 'finding',
                dismissedAt: f.dismissed ? new Date() : null,
              })),
            )
            .returning();
    // `returning()` keeps the VALUES order.
    findingIds.push(rows.map((r) => r.id));
  }
  const ids: Record<string, string> = {};
  findings.forEach((f, i) => {
    ids[f.key] = findingIds[0]![i]!;
  });
  return { repoId: repo!.id, prId: pr!.id, reviewIds, reviewId: reviewIds[0]!, findingIds, ids };
}

/** A fake gitlab.com with the service-account token and the MR at `headSha`. */
export function addPublishMr(fake: FakeGitLab, fullPath: string, opts: { iid?: number; headSha?: string } = {}) {
  return fake.addMr(fullPath, opts.iid ?? PUB_IID, {
    baseSha: 'base5',
    startSha: 'start5',
    headSha: opts.headSha ?? PUB_HEAD,
  });
}

export function newPublishFake(): FakeGitLab {
  return new FakeGitLab().addToken(PUB_TOKEN, SERVICE_ACCOUNT, ['api', 'read_user']);
}

/** Local-mode app (no footer, no audit) over the shared fixture DB and the fake gitlab.com. */
export async function buildLocalPublishApp(
  pg: PgFixture,
  fake: FakeGitLab,
  opts: { token?: string | null; logs?: string[]; fetch?: FakeGitLab['fetch'] } = {},
): Promise<FastifyInstance> {
  const token = opts.token === undefined ? PUB_TOKEN : opts.token;
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const logs = opts.logs ?? [];
  const app = await buildApp({
    config,
    db: pg.handle.db,
    logStream: { write: (line) => void logs.push(line) },
    overrides: {
      git: new MockGitClient(),
      github: new MockGitHubClient(),
      secrets: new MockSecretsProvider(token ? { GITLAB_TOKEN: token } : {}),
      gitlabFetch: opts.fetch ?? fake.fetch,
    },
  });
  await app.ready();
  return app;
}

/**
 * Awaits every live publish task and reconcile of `app`. A reconcile TRIGGER
 * (preview / list reads) first runs a DB query before its task is registered,
 * so `whenIdle()` alone can miss it: settle over a few short quiet periods.
 */
export async function settle(app: FastifyInstance): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await app.container.publishRunner.whenIdle();
    await app.container.publishReconciler.whenIdle();
    await new Promise((r) => setTimeout(r, 25));
  }
  await app.container.publishRunner.whenIdle();
  await app.container.publishReconciler.whenIdle();
}

export async function getPublication(app: FastifyInstance, id: string, headers: Record<string, string> = {}): Promise<Publication> {
  const res = await app.inject({ method: 'GET', url: `/publications/${id}`, headers });
  if (res.statusCode !== 200) throw new Error(`GET /publications/${id} → ${res.statusCode} ${res.body}`);
  return res.json() as Publication;
}

/** The URL path of the MR on the fake (percent-encoded project path). */
export function mrApiPath(fullPath: string, iid = PUB_IID): string {
  return `/api/v4/projects/${encodeURIComponent(fullPath)}/merge_requests/${iid}`;
}
