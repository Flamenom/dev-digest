import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SecretKey, SecretsProvider } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { AppError } from '../src/platform/errors.js';
import {
  MockGitClient,
  MockGitHubClient,
  MockGitLabClient,
  type MockGitLabOptions,
} from '../src/adapters/mocks.js';
import { RepoService, type CloneJobPayload } from '../src/modules/repos/service.js';

/**
 * T5 — repo identity for github.com + gitlab.com through `POST /repos`,
 * `POST /repos/:id/refresh` and the clone job (AC-6..17, AC-36, AC-47, AC-52, Q8).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[repos-gitlab] Docker not available — skipping Testcontainers tests.');
}

const GITHUB_TOKEN = 'ghp_t5SecretGithubToken0000';
const GITLAB_TOKEN = 'glpat-t5SecretGitlabToken000';

/** SecretsProvider that records every key read (AC-13: never GITHUB_TOKEN for GitLab). */
class RecordingSecrets implements SecretsProvider {
  reads: string[] = [];
  constructor(private values: Partial<Record<string, string>> = {}) {}
  async get(key: SecretKey): Promise<string | undefined> {
    this.reads.push(key as string);
    return this.values[key as string];
  }
}

d('repos: github.com + gitlab.com identity', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
  });
  afterAll(async () => {
    await pg?.stop();
  });

  async function makeApp(
    opts: { gitlab?: MockGitLabOptions; secrets?: Record<string, string> } = {},
  ) {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const git = new MockGitClient();
    const gitlab = new MockGitLabClient(opts.gitlab);
    const secrets = new RecordingSecrets(
      opts.secrets ?? { GITHUB_TOKEN, GITLAB_TOKEN },
    );
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: { git, github: new MockGitHubClient(), gitlab, secrets },
    });
    return { app, git, gitlab, secrets };
  }

  async function clonePayloads(repoId: string): Promise<CloneJobPayload[]> {
    const rows = await pg.handle.db.select().from(t.jobs).where(eq(t.jobs.kind, 'clone'));
    return rows
      .map((r) => r.payload as CloneJobPayload)
      .filter((p) => p?.repoId === repoId);
  }

  function assertTokenless(url: string): void {
    expect(url).not.toMatch(/\/\/[^/]*@/);
    expect(url).not.toContain(GITHUB_TOKEN);
    expect(url).not.toContain(GITLAB_TOKEN);
    expect(url).not.toContain('x-access-token');
    expect(url).not.toContain('oauth2');
  }

  it('adds a mixed-case gitlab URL under the canonical path_with_namespace and dedupes every form (AC-6/8/16/36/52)', async () => {
    const CANONICAL = 'space-profit/platform/crm-frontend';
    const { app, git, gitlab } = await makeApp({
      gitlab: { project: { fullPath: CANONICAL, defaultBranch: 'develop' } },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/repos',
      payload: { url: 'https://gitlab.com/Space-Profit/Platform/CRM-Frontend' },
    });
    expect(create.statusCode).toBe(201);
    const repo = create.json();
    expect(repo).toMatchObject({
      provider: 'gitlab',
      host: 'gitlab.com',
      owner: 'space-profit/platform',
      name: 'crm-frontend',
      full_name: CANONICAL,
      default_branch: 'develop',
      web_url: 'https://gitlab.com/space-profit/platform/crm-frontend',
      sync_state: 'idle',
    });
    expect(gitlab.callsOf('project')[0]!.fullPath).toBe('Space-Profit/Platform/CRM-Frontend');

    for (const url of [
      `https://gitlab.com/${CANONICAL}`,
      `https://gitlab.com/${CANONICAL}/`,
      `https://gitlab.com/${CANONICAL}.git`,
      `https://gitlab.com/${CANONICAL}/-/tree/main`,
      `https://gitlab.com/${CANONICAL}/-/merge_requests/5?ref=main#readme`,
      `git@gitlab.com:${CANONICAL}.git`,
      'https://gitlab.com/SPACE-PROFIT/platform/Crm-Frontend',
    ]) {
      const again = await app.inject({ method: 'POST', url: '/repos', payload: { url } });
      expect(again.statusCode, url).toBe(200);
      expect(again.json().id, url).toBe(repo.id);
    }

    await app.container.jobs.onIdle();
    const cloned = git.cloned.filter((c) => c.repo.name === 'crm-frontend');
    expect(cloned).toHaveLength(1);
    expect(cloned[0]!.url).toBe(`https://gitlab.com/${CANONICAL}.git`);
    assertTokenless(cloned[0]!.url);

    const list = (await app.inject({ method: 'GET', url: '/repos' })).json() as {
      id: string;
      clone_path: string | null;
    }[];
    expect(list.find((r) => r.id === repo.id)?.clone_path).toBe(
      `/mock/clones/@gitlab.com/${CANONICAL}`,
    );
    await app.close();
  });

  it('rejects unsupported hosts and unsafe paths with 400 and no GitLab call (AC-9/AC-10)', async () => {
    const { app, gitlab } = await makeApp();
    const cases: [string, string | null][] = [
      ['https://gitlab.example.com/a/b', 'unsupported_repo_host'],
      ['https://www.gitlab.com/a/b', 'unsupported_repo_host'],
      ['https://1.2.3.4/a/b', 'unsupported_repo_host'],
      ['https://gitlab.com:8443/a/b', 'unsupported_repo_host'],
      ['https://user@gitlab.com/a/b', 'unsupported_repo_host'],
      ['http://gitlab.com/a/b', 'unsupported_repo_host'],
      ['https://gitlab.com/a/../b', null],
      ['https://gitlab.com/a/%2e%2e/b', null],
      ['https://gitlab.com/a/b;rm', null],
      [`https://gitlab.com/${Array.from({ length: 22 }, (_, i) => `g${i}`).join('/')}`, null],
    ];
    for (const [url, code] of cases) {
      const res = await app.inject({ method: 'POST', url: '/repos', payload: { url } });
      expect(res.statusCode, url).toBe(400);
      if (code) expect(res.json().error.code, url).toBe(code);
    }
    expect(gitlab.calls).toHaveLength(0);
    await app.close();
  });

  it('keeps the same path on github.com and gitlab.com as two repos with two clones (AC-15)', async () => {
    const { app, git } = await makeApp();
    const gh = await app.inject({
      method: 'POST',
      url: '/repos',
      payload: { url: 'https://github.com/acme-t5/web' },
    });
    const gl = await app.inject({
      method: 'POST',
      url: '/repos',
      payload: { url: 'https://gitlab.com/acme-t5/web' },
    });
    expect(gh.statusCode).toBe(201);
    expect(gl.statusCode).toBe(201);
    expect(gh.json().id).not.toBe(gl.json().id);
    expect(gh.json()).toMatchObject({ provider: 'github', host: 'github.com', web_url: 'https://github.com/acme-t5/web' });
    expect(gl.json()).toMatchObject({ provider: 'gitlab', host: 'gitlab.com', web_url: 'https://gitlab.com/acme-t5/web' });

    await app.container.jobs.onIdle();
    const paths = git.cloned
      .filter((c) => c.repo.owner === 'acme-t5')
      .map((c) => git.clonePathFor(c.repo));
    expect(new Set(paths)).toEqual(
      new Set(['/mock/clones/acme-t5/web', '/mock/clones/@gitlab.com/acme-t5/web']),
    );
    for (const c of git.cloned) assertTokenless(c.url);
    for (const id of [gh.json().id, gl.json().id]) {
      for (const p of await clonePayloads(id)) assertTokenless(p.url);
    }
    await app.close();
  });

  it('private project without a GitLab token → 400 gitlab_token_missing, no GITHUB_TOKEN read (AC-13)', async () => {
    const { app, secrets } = await makeApp({
      secrets: { GITHUB_TOKEN },
      gitlab: {
        errors: {
          project: new AppError(
            'gitlab_token_missing',
            'Connect a GitLab token in Settings → API keys: this gitlab.com project is private or does not exist.',
            400,
          ),
        },
      },
    });
    secrets.reads = [];
    const res = await app.inject({
      method: 'POST',
      url: '/repos',
      payload: { url: 'https://gitlab.com/private-t5/secret-app' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('gitlab_token_missing');
    expect(res.json().error.message).toMatch(/GitLab token/);
    expect(secrets.reads).not.toContain('GITHUB_TOKEN');
    await app.close();
  });

  it('token without access → 404 gitlab_project_inaccessible (AC-14)', async () => {
    const { app } = await makeApp({
      gitlab: {
        errors: {
          project: new AppError(
            'gitlab_project_inaccessible',
            'GitLab project not found or token has no access.',
            404,
          ),
        },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/repos',
      payload: { url: 'https://gitlab.com/private-t5/no-access' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('gitlab_project_inaccessible');
    await app.close();
  });

  it('clone job: tokenless remote, no secret reads, GitLab auth failure → Settings hint, redacted (Q8/AC-12/13)', async () => {
    const { app, secrets } = await makeApp();
    const service = new RepoService(app.container);

    secrets.reads = [];
    const [row] = await pg.handle.db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.fullName, 'acme-t5/web'), eq(t.repos.provider, 'gitlab')));
    await service.runCloneJob({
      repoId: row!.id,
      owner: 'acme-t5',
      name: 'web',
      provider: 'gitlab',
      host: 'gitlab.com',
      // A hostile payload URL is ignored — the remote is rebuilt from identity.
      url: `https://oauth2:${GITLAB_TOKEN}@evil.example.com/x.git`,
    });
    expect(secrets.reads).not.toContain('GITHUB_TOKEN');
    expect(secrets.reads).not.toContain('GITLAB_TOKEN');

    class FailingGit extends MockGitClient {
      override async clone(): Promise<{ path: string }> {
        throw new Error(
          `fatal: Authentication failed for 'https://oauth2:${GITLAB_TOKEN}@gitlab.com/acme-t5/web.git/'`,
        );
      }
    }
    const failing = await buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: {
        git: new FailingGit(),
        github: new MockGitHubClient(),
        gitlab: new MockGitLabClient(),
        secrets: new RecordingSecrets({ GITLAB_TOKEN }),
      },
    });
    const err = await new RepoService(failing.container)
      .runCloneJob({ repoId: row!.id, owner: 'acme-t5', name: 'web', provider: 'gitlab', host: 'gitlab.com', url: '' })
      .catch((e: unknown) => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('gitlab_token_missing');
    expect((err as AppError).message).toMatch(/connect a GitLab token in Settings/);
    expect(JSON.stringify({ m: (err as AppError).message, d: (err as AppError).details })).not.toContain(
      GITLAB_TOKEN,
    );
    await failing.close();
    await app.close();
  });

  it('refresh rebuilds the remote from stored identity: gitlab.com for GitLab, unchanged for GitHub (AC-17/AC-47)', async () => {
    const { app, git } = await makeApp();
    const repos = (await app.inject({ method: 'GET', url: '/repos' })).json() as {
      id: string;
      provider: string;
      full_name: string;
      clone_path: string | null;
    }[];
    const gl = repos.find((r) => r.provider === 'gitlab' && r.full_name === 'acme-t5/web')!;
    const gh = repos.find((r) => r.provider === 'github' && r.full_name === 'acme-t5/web')!;
    const ghClonePathBefore = gh.clone_path;

    for (const r of [gl, gh]) {
      const res = await app.inject({ method: 'POST', url: `/repos/${r.id}/refresh` });
      expect(res.statusCode).toBe(200);
    }
    await app.container.jobs.onIdle();

    const glPayloads = await clonePayloads(gl.id);
    expect(glPayloads.at(-1)).toMatchObject({
      provider: 'gitlab',
      host: 'gitlab.com',
      url: 'https://gitlab.com/acme-t5/web.git',
    });
    const ghPayloads = await clonePayloads(gh.id);
    expect(ghPayloads.at(-1)!.url).toBe('https://github.com/acme-t5/web.git');
    for (const p of [...glPayloads, ...ghPayloads]) assertTokenless(p.url);
    for (const c of git.cloned) assertTokenless(c.url);

    const after = (await app.inject({ method: 'GET', url: '/repos' })).json() as {
      id: string;
      clone_path: string | null;
    }[];
    expect(after.find((r) => r.id === gh.id)!.clone_path).toBe(ghClonePathBefore);
    expect(after.find((r) => r.id === gl.id)!.clone_path).toBe('/mock/clones/@gitlab.com/acme-t5/web');
    await app.close();
  });

  it('GET /repos lists in created_at order', async () => {
    const { app } = await makeApp();
    const ids = ((await app.inject({ method: 'GET', url: '/repos' })).json() as { id: string }[]).map(
      (r) => r.id,
    );
    const rows = await pg.handle.db.select().from(t.repos).orderBy(t.repos.createdAt, t.repos.id);
    const listed = new Set(ids);
    expect(ids).toEqual(rows.filter((r) => listed.has(r.id)).map((r) => r.id));
    await app.close();
  });
});
