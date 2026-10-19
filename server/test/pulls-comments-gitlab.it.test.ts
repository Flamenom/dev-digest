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
 * T12 — inline comments on a GitLab MR are read-only in the MVP (Q3):
 * POST → 400 `provider_read_only` with no host call (AC-44), GET → `[]` without
 * resolving any client (AC-45).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[pulls-comments-gitlab] Docker not available — skipping Testcontainers tests.');
}

d('GitLab MR comments are read-only (Testcontainers pg)', () => {
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
        secrets: new MockSecretsProvider({ GITHUB_TOKEN: 'x', GITLAB_TOKEN: 'y' }),
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
      })
      .returning();
    return { app, gitlab, github, pr: pr! };
  }

  it('POST → 400 provider_read_only and no host call (AC-44)', async () => {
    const { app, gitlab, github, pr } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/comments`,
      payload: { path: 'src/import.ts', line: 2, body: 'Please extract this.' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('provider_read_only');
    expect(body.error.message).toBe('Posting to GitLab is not supported yet.');
    expect(gitlab.calls).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it('GET → 200 [] without resolving any client (AC-45)', async () => {
    const { app, gitlab, github, pr } = await setup();
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/comments` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(gitlab.calls).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });
});
