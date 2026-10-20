import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { SecretKey, SecretsProvider } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { FakeGitLab } from './helpers/fake-gitlab.js';

/**
 * T7 — the GitLab token scope gate end to end (spec 2026-10-20-gitlab-comments
 * AC-21, AC-22, AC-23, AC-24, AC-28): real container wiring
 * (`gitlabTokenHealth` in front of `gitlab()`, `prHost()`, `prComments`,
 * `gitlabToken`) and the real `RestGitLabClient` over a fake gitlab.com.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[gitlab-token-gate] Docker not available — skipping.');

const READ_API_TOKEN = 'glpat-gateReadApiOnly00000000003';
const OTHER_READ_API = 'glpat-gateAnotherReadApi0000004';
const FLAKY_TOKEN = 'glpat-gateScopeLookup503000005';
const API_TOKEN = 'glpat-gateFullApiScope000000006';
const INSUFFICIENT_MESSAGE =
  'This token is missing the api scope. Required scope: api (Reporter role recommended).';

/** In-memory read/write SecretsProvider (local-mode BYO keys). */
class MemorySecrets implements SecretsProvider {
  constructor(readonly values: Partial<Record<string, string>> = {}) {}
  async get(key: SecretKey): Promise<string | undefined> {
    return this.values[key as string];
  }
  async set(key: SecretKey, value: string): Promise<void> {
    this.values[key as string] = value;
  }
}

d('GitLab token scope gate (fake GitLab, Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let app: FastifyInstance;
  let fake: FakeGitLab;
  let secrets: MemorySecrets;
  let github: MockGitHubClient;

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    fake = new FakeGitLab()
      .addToken(READ_API_TOKEN, 'legacy-bot', ['read_api', 'read_user'])
      .addToken(OTHER_READ_API, 'other-bot', ['read_api'])
      .addToken(FLAKY_TOKEN, 'flaky-bot', ['api'])
      .addToken(API_TOKEN, 'devdigest-bot', ['api']);
    fake.addProject('gl-gate/new-project');
    fake.addMr('gl-gate/synced', 3, { headSha: 'gatehead' });
    secrets = new MemorySecrets({ GITLAB_TOKEN: READ_API_TOKEN });
    github = new MockGitHubClient();
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), secrets, gitlabFetch: fake.fetch, github },
    });
  });
  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await pg?.stop();
  });

  async function insertRepo(values: Partial<typeof t.repos.$inferInsert> & { name: string; owner: string }) {
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, fullName: `${values.owner}/${values.name}`, ...values })
      .returning();
    return repo!;
  }

  async function syncAndWait(repoId: string) {
    const res = await app.inject({ method: 'POST', url: `/repos/${repoId}/pulls/sync` });
    expect(res.statusCode).toBe(200);
    await app.container.prSync.awaitRunning(repoId);
    const [row] = await pg.handle.db.select().from(t.repos).where(eq(t.repos.id, repoId));
    return row!;
  }

  const health = async () =>
    (await app.inject({ method: 'GET', url: '/settings/secrets-status' })).json().gitlab_health as string | null;

  const testConnection = (key: string) =>
    app.inject({ method: 'POST', url: '/settings/test-connection', payload: { provider: 'gitlab', key } });

  let glRepoId: string;
  let glPrId: string;

  it('AC-23 + AC-24: a stored read_api token blocks every GitLab op with ONE scope lookup; persisted data stays readable; GitHub still syncs', async () => {
    const glRepo = await insertRepo({ owner: 'gl-gate', name: 'synced', provider: 'gitlab', host: 'gitlab.com' });
    glRepoId = glRepo.id;
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: glRepo.id,
        number: 3,
        title: 'Persisted MR',
        author: 'olena.dev',
        branch: 'feat/3',
        base: 'main',
        headSha: 'gatehead',
        detailHeadSha: 'gatehead',
        status: 'open',
      })
      .returning();
    glPrId = pr!.id;
    await pg.handle.db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/a.ts',
      additions: 1,
      patch: '@@ -0,0 +1,1 @@\n+x',
    });

    // Add a GitLab project → blocked.
    const add = await app.inject({
      method: 'POST',
      url: '/repos',
      payload: { url: 'https://gitlab.com/gl-gate/new-project' },
    });
    expect(add.statusCode).toBe(400);
    expect(add.json().error).toMatchObject({ code: 'gitlab_token_insufficient_scope', message: INSUFFICIENT_MESSAGE });

    // List sync → failed with the coded error, 0 MR requests.
    const synced = await syncAndWait(glRepo.id);
    expect(synced.lastSyncError ?? '').toMatch(/^\[gitlab_token_insufficient_scope\]/);
    expect(fake.matching('/api/graphql')).toHaveLength(0);
    expect(fake.matching('/merge_requests')).toHaveLength(0);

    // Detail serves the persisted MR; comments read → []; comment post → the code.
    const detail = await app.inject({ method: 'GET', url: `/pulls/${pr!.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ title: 'Persisted MR', number: 3 });
    expect(detail.json().files.map((f: { path: string }) => f.path)).toEqual(['src/a.ts']);

    const list = await app.inject({ method: 'GET', url: `/pulls/${pr!.id}/comments` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    const post = await app.inject({
      method: 'POST',
      url: `/pulls/${pr!.id}/comments`,
      payload: { path: 'src/a.ts', line: 1, body: 'blocked?' },
    });
    expect(post.statusCode).toBe(400);
    expect(post.json().error.code).toBe('gitlab_token_insufficient_scope');

    // Exactly ONE scope lookup across all those ops (memoised, AC-24); no anonymous fallback.
    expect(fake.matching('/personal_access_tokens/self')).toHaveLength(1);
    expect(fake.requests.every((r) => r.token === READ_API_TOKEN)).toBe(true);
    expect(fake.requests.filter((r) => !/\/(user|personal_access_tokens\/self)$/.test(r.path))).toEqual([]);
    expect(await health()).toBe('insufficient_scope');

    // Mixed workspace: a GitHub repo still syncs while GitLab is blocked.
    const ghRepo = await insertRepo({ owner: 'gh-gate', name: 'svc' });
    const ghSynced = await syncAndWait(ghRepo.id);
    expect(ghSynced.lastSyncError).toBeNull();
    expect(ghSynced.lastSyncedAt).not.toBeNull();
  });

  it('AC-21: saving a read_api key → ok:false with the code + exact message; nothing stored, previous token kept', async () => {
    const before = (await app.inject({ method: 'GET', url: '/settings/secrets-status' })).json();
    const res = await testConnection(OTHER_READ_API);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: 'gitlab',
      ok: false,
      code: 'gitlab_token_insufficient_scope',
      message: INSUFFICIENT_MESSAGE,
    });
    expect(res.payload).not.toContain(OTHER_READ_API);
    expect(secrets.values.GITLAB_TOKEN).toBe(READ_API_TOKEN);
    expect((await app.inject({ method: 'GET', url: '/settings/secrets-status' })).json()).toEqual(before);
  });

  it('AC-28: the scope lookup answers 503 → gitlab_token_unverified and nothing is stored', async () => {
    fake.when('GET', '/personal_access_tokens/self', { status: 503, headers: { 'retry-after': '0' } }, 10);
    const res = await testConnection(FLAKY_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'gitlab', ok: false, code: 'gitlab_token_unverified' });
    expect(secrets.values.GITLAB_TOKEN).toBe(READ_API_TOKEN);
    fake.reset();
  });

  it('AC-22 + AC-24: saving an api token → stored, ok:true "Connected as @…", health ok, and the next sync performs MR requests', async () => {
    const res = await testConnection(API_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'gitlab', ok: true, message: 'Connected as @devdigest-bot' });
    expect(secrets.values.GITLAB_TOKEN).toBe(API_TOKEN);
    expect(await health()).toBe('ok');

    fake.reset();
    const synced = await syncAndWait(glRepoId);
    expect(synced.lastSyncError).toBeNull();
    const gql = fake.matching('/api/graphql');
    expect(gql.length).toBeGreaterThan(0);
    expect(gql.every((r) => r.token === API_TOKEN)).toBe(true);
    // Health was recorded on save → no new scope lookup before the sync.
    expect(fake.matching('/personal_access_tokens/self')).toHaveLength(0);

    // Comments read now reaches GitLab too.
    const list = await app.inject({ method: 'GET', url: `/pulls/${glPrId}/comments` });
    expect(list.statusCode).toBe(200);
    expect(fake.matching(/\/merge_requests\/3\/discussions$/, 'GET')).toHaveLength(1);
  });
});
