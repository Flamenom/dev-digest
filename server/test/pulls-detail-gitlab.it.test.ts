import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PrDetailHost, PrFileHost } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import {
  MockGitClient,
  MockGitHubClient,
  MockGitLabClient,
  MockSecretsProvider,
} from '../src/adapters/mocks.js';

/**
 * T12 — provider-aware PR detail (`GET /pulls/:id`): GitLab refetches files/
 * commits only when the head moved (Q6), persists renamed / omitted files,
 * reports `files_omitted_by_host`, and serves the persisted detail when the host
 * is unavailable (AC-21/24/26/33/51/54). GitHub stays always-full (AC-48).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[pulls-detail-gitlab] Docker not available — skipping Testcontainers tests.');
}

const MR = 5;
const HEAD = 'f00dbabe5';

const FILES: PrFileHost[] = [
  {
    path: 'src/contacts/importer.ts',
    previous_path: 'src/contacts/import.ts',
    change_type: 'renamed',
    additions: 4,
    deletions: 1,
    patch: '@@ -1,2 +1,5 @@\n export {};\n+const a = 1;\n+const b = 2;\n+const c = 3;\n-const z = 0;',
    patch_omitted: null,
  },
  {
    path: 'fixtures/contacts.csv',
    previous_path: null,
    change_type: 'added',
    additions: 0,
    deletions: 0,
    patch: null,
    patch_omitted: 'too_large',
  },
];

d('GET /pulls/:id — GitLab detail (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let seq = 0;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
  });
  afterAll(async () => {
    for (const app of apps) await app.close().catch(() => undefined);
    await pg?.stop();
  });

  async function makeApp(gitlab: MockGitLabClient, github = new MockGitHubClient()) {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), secrets: new MockSecretsProvider({}), gitlab, github },
    });
    apps.push(app);
    return app;
  }

  /** A GitLab repo + one persisted MR whose stats are unknown and whose detail was never fetched. */
  async function gitlabPr() {
    seq += 1;
    const name = `detail-${seq}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'gl-group/sub',
        name,
        fullName: `gl-group/sub/${name}`,
        provider: 'gitlab',
        host: 'gitlab.com',
      })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: MR,
        title: 'Add CRM contact import',
        author: 'olena.dev',
        branch: 'feat/contact-import',
        base: 'main',
        headSha: HEAD,
        additions: 0,
        deletions: 0,
        filesCount: 0,
        status: 'open',
        isDraft: false,
        statsKnown: false,
      })
      .returning();
    return { repo: repo!, pr: pr! };
  }

  function mockHost() {
    return new MockGitLabClient({
      details: {
        [MR]: { is_draft: true, files: FILES, additions: 4, deletions: 1, files_count: 2 },
      },
    });
  }

  async function prRow(id: string) {
    const [row] = await pg.handle.db.select().from(t.pullRequests).where(eq(t.pullRequests.id, id));
    return row!;
  }

  it('first open persists renamed + omitted files, commits and known stats; draft flag (AC-21/24/33/51/54)', async () => {
    const gitlab = mockHost();
    const app = await makeApp(gitlab);
    const { pr } = await gitlabPr();

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrDetailHost;
    expect(body.id).toBe(pr.id);
    expect(body.files_omitted_by_host).toBe(1);
    expect(body.is_draft).toBe(true);
    expect(body.files).toHaveLength(2);
    expect(body.files[0]).toMatchObject({ previous_path: 'src/contacts/import.ts', change_type: 'renamed' });
    expect(body.files[1]).toMatchObject({ patch: null, patch_omitted: 'too_large' });

    const files = await pg.handle.db.select().from(t.prFiles).where(eq(t.prFiles.prId, pr.id));
    expect(files).toHaveLength(2);
    const renamed = files.find((f) => f.path === 'src/contacts/importer.ts')!;
    expect(renamed.previousPath).toBe('src/contacts/import.ts');
    expect(renamed.changeType).toBe('renamed');
    const big = files.find((f) => f.path === 'fixtures/contacts.csv')!;
    expect(big.patch).toBeNull();
    expect(big.patchOmitted).toBe('too_large');
    const commits = await pg.handle.db.select().from(t.prCommits).where(eq(t.prCommits.prId, pr.id));
    expect(commits).toHaveLength(1);

    const row = await prRow(pr.id);
    expect(row.statsKnown).toBe(true);
    expect(row.additions).toBe(4);
    expect(row.filesCount).toBe(2);
    expect(row.isDraft).toBe(true);
    expect(row.detailHeadSha).toBe(HEAD);
    expect(gitlab.callsOf('diffs')).toHaveLength(1);
    expect(gitlab.callsOf('commits')).toHaveLength(1);
  });

  it('second open with the same head makes 0 diff/commit calls; a moved head refetches (Q6)', async () => {
    const gitlab = mockHost();
    const app = await makeApp(gitlab);
    const { pr } = await gitlabPr();

    await app.inject({ method: 'GET', url: `/pulls/${pr.id}` });
    expect(gitlab.callsOf('diffs')).toHaveLength(1);

    const again = await app.inject({ method: 'GET', url: `/pulls/${pr.id}` });
    expect(again.statusCode).toBe(200);
    expect(gitlab.callsOf('diffs')).toHaveLength(1);
    expect(gitlab.callsOf('commits')).toHaveLength(1);
    const cached = again.json() as PrDetailHost;
    expect(cached.files).toHaveLength(2);
    expect(cached.files_omitted_by_host).toBe(1);
    expect(cached.is_draft).toBe(true);
    expect(cached.stats_known).toBe(true);
    // Persisted stats are kept (the unchanged meta carries none).
    expect(cached.additions).toBe(4);
    expect(cached.files_count).toBe(2);
    const renamed = cached.files.find((f) => f.path === 'src/contacts/importer.ts')!;
    expect(renamed).toMatchObject({ previous_path: 'src/contacts/import.ts', change_type: 'renamed' });
    expect((await prRow(pr.id)).additions).toBe(4);

    // Head moves on the host → full refetch.
    gitlab.opts.details![MR] = {
      ...gitlab.opts.details![MR],
      head_sha: 'c0ffee77',
      is_draft: false,
      files: [FILES[0]!],
      files_count: 1,
    };
    const moved = await app.inject({ method: 'GET', url: `/pulls/${pr.id}` });
    expect(moved.statusCode).toBe(200);
    expect(gitlab.callsOf('diffs')).toHaveLength(2);
    const fresh = moved.json() as PrDetailHost;
    expect(fresh.head_sha).toBe('c0ffee77');
    expect(fresh.files).toHaveLength(1);
    expect(fresh.files_omitted_by_host).toBe(0);
    expect(fresh.is_draft).toBe(false);
    const row = await prRow(pr.id);
    expect(row.detailHeadSha).toBe('c0ffee77');
    expect(row.isDraft).toBe(false);
  });

  it('host offline → persisted detail with 200 (AC-26)', async () => {
    const gitlab = mockHost();
    const app = await makeApp(gitlab);
    const { pr } = await gitlabPr();
    await app.inject({ method: 'GET', url: `/pulls/${pr.id}` });

    gitlab.opts.errors = { merge_request: new Error('getaddrinfo ENOTFOUND gitlab.com') };
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrDetailHost;
    expect(body.files).toHaveLength(2);
    expect(body.files_omitted_by_host).toBe(1);
    expect(body.commits).toHaveLength(1);
    expect(body.is_draft).toBe(true);
  });

  it('GitHub detail keeps the pre-GitLab field set (AC-48)', async () => {
    const gh = new MockGitHubClient();
    const app = await makeApp(new MockGitLabClient(), gh);
    seq += 1;
    const name = `gh-detail-${seq}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 1,
        title: 't',
        author: 'a',
        branch: 'b',
        base: 'main',
        headSha: 'abc',
        additions: 0,
        deletions: 0,
        filesCount: 0,
        status: 'open',
      })
      .returning();

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr!.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const expected = { ...(await gh.getPullRequest({ owner: 'acme', name }, 1)), id: pr!.id };
    expect(Object.keys(body).sort()).toEqual(Object.keys(expected).sort());
    expect(body).not.toHaveProperty('files_omitted_by_host');
    expect(body).not.toHaveProperty('is_draft');
    const row = await prRow(pr!.id);
    expect(row.detailHeadSha).toBeNull();
    expect(row.statsKnown).toBeNull();
  });
});
