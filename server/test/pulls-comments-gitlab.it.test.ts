import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
 * GitLab MR comments without a configured GitLab token (spec
 * 2026-10-20-gitlab-comments; supersedes the read-only MVP AC-44/AC-45):
 * GET → `200 []` with no GitLab request (AC-6/AC-29), POST →
 * `400 gitlab_token_missing` with no GitLab request (AC-29). `provider_read_only`
 * is no longer emitted for comments.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[pulls-comments-gitlab] Docker not available — skipping Testcontainers tests.');
}

d('GitLab MR comments without a GitLab token (Testcontainers pg)', () => {
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

  async function setup() {
    const gitlab = new MockGitLabClient();
    const github = new MockGitHubClient();
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        // No GITLAB_TOKEN: the token gate answers "none configured".
        secrets: new MockSecretsProvider({ GITHUB_TOKEN: 'x' }),
        gitlab,
        github,
      },
    });
    apps.push(app);

    seq += 1;
    const name = `comments-${seq}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'gl-group',
        name,
        fullName: `gl-group/${name}`,
        provider: 'gitlab',
        host: 'gitlab.com',
      })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 5,
        title: 'Add CRM contact import',
        author: 'olena.dev',
        branch: 'feat/contact-import',
        base: 'main',
        headSha: 'f00dbabe5',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'open',
        detailHeadSha: 'f00dbabe5',
      })
      .returning();
    // The persisted diff the comment targets (line 2 is an added line).
    await pg.handle.db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/import.ts',
      additions: 2,
      deletions: 0,
      patch: '@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;',
    });
    return { app, gitlab, github, pr: pr! };
  }

  it('POST → 400 gitlab_token_missing and no host call (AC-29)', async () => {
    const { app, gitlab, github, pr } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/comments`,
      payload: { path: 'src/import.ts', line: 2, body: 'Please extract this.' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('gitlab_token_missing');
    expect(gitlab.calls).toEqual([]);
    expect(gitlab.posted).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it('GET → 200 [] with no GitLab request (AC-6/AC-29)', async () => {
    const { app, gitlab, github, pr } = await setup();
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/comments` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(gitlab.calls).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });
});
