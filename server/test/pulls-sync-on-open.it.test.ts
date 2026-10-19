import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PrMeta, RepoRef } from '@devdigest/shared';
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
 * T9 — sync-on-open list routes, manual sync, one-shot SSE completion and
 * `/poll` through the single-flight coordinator (AC-25/27/55..64).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[pulls-sync-on-open] Docker not available — skipping Testcontainers tests.');
}

type Mode = 'ok' | 'hang' | 'fail' | 'gate';

/** GitHub mock whose list call can succeed, hang forever, fail (500) or wait on a gate. */
class ControlledGitHub extends MockGitHubClient {
  listCalls = 0;
  private waiters: (() => void)[] = [];
  constructor(public mode: Mode = 'ok') {
    super();
  }
  release(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  override async listPullRequests(repo: RepoRef): Promise<PrMeta[]> {
    this.listCalls += 1;
    if (this.mode === 'hang') return new Promise<PrMeta[]>(() => undefined);
    if (this.mode === 'fail') throw new Error('GitHub API responded 500 Internal Server Error');
    if (this.mode === 'gate') await new Promise<void>((r) => this.waiters.push(r));
    return super.listPullRequests(repo);
  }
}

/** The PR-list DTO field set before GitLab support (AC-60). */
const GITHUB_DTO_KEYS = [
  'additions',
  'author',
  'base',
  'branch',
  'cost_usd',
  'deletions',
  'files_count',
  'findings',
  'head_sha',
  'id',
  'number',
  'opened_at',
  'score',
  'status',
  'title',
  'updated_at',
].sort();

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

d('PR list: sync-on-open, manual sync, SSE completion', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let seq = 0;
  let clock = T0;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
  });
  afterAll(async () => {
    for (const app of apps) await app.close().catch(() => undefined);
    await pg?.stop();
  });

  async function makeApp(
    opts: { github?: ControlledGitHub | null; gitlab?: MockGitLabClient } = {},
  ): Promise<FastifyInstance> {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        // No secrets on disk: a missing `github` override ⇒ GITHUB_TOKEN missing.
        secrets: new MockSecretsProvider({}),
        ...(opts.github ? { github: opts.github } : {}),
        ...(opts.gitlab ? { gitlab: opts.gitlab } : {}),
        prSyncClock: () => clock,
      },
    });
    apps.push(app);
    return app;
  }

  async function newRepo(
    over: Partial<typeof t.repos.$inferInsert> = {},
    prNumbers: number[] = [],
  ): Promise<typeof t.repos.$inferSelect> {
    seq += 1;
    const name = `list-${seq}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'sync-it', name, fullName: `sync-it/${name}`, ...over })
      .returning();
    if (prNumbers.length > 0) {
      await pg.handle.db.insert(t.pullRequests).values(
        prNumbers.map((number) => ({
          workspaceId,
          repoId: repo!.id,
          number,
          title: `Persisted PR ${number}`,
          author: 'dev',
          branch: `feat/${number}`,
          base: 'main',
          headSha: `sha-${number}`,
          additions: 3,
          deletions: 1,
          filesCount: 1,
          status: 'open',
        })),
      );
    }
    return repo!;
  }

  async function repoRow(id: string) {
    const [row] = await pg.handle.db.select().from(t.repos).where(eq(t.repos.id, id));
    return row!;
  }

  it('list reads serve persisted rows while the host never answers (AC-55)', async () => {
    clock = T0;
    const github = new ControlledGitHub('hang');
    const app = await makeApp({ github });
    const repo = await newRepo({}, [1, 2]);

    const list = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls` });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json())).toBe(true); // MCP relies on the bare array (Q2)
    expect(list.json().map((p: { number: number }) => p.number).sort()).toEqual([1, 2]);

    const page = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/page` });
    expect(page.statusCode).toBe(200);
    expect(page.json().pulls).toHaveLength(2);
    // The array read above already started the (hanging) sync → the page joins it.
    expect(page.json().sync.trigger).toBe('joined');
    expect(page.json().sync.state).toBe('running');
    expect(github.listCalls).toBe(1);

    const repos = await app.inject({ method: 'GET', url: '/repos' });
    const dto = repos.json().find((r: { id: string }) => r.id === repo.id);
    expect(dto.sync_state).toBe('running');
  });

  it('TTL from the last success: +61 s → started (1 call), then +30 s → fresh (0 calls) (AC-56/61)', async () => {
    const github = new ControlledGitHub('ok');
    const app = await makeApp({ github });
    const repo = await newRepo({ lastSyncedAt: new Date(T0), lastAttemptAt: new Date(T0) });

    clock = T0 + 61_000;
    const opened = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/page` });
    expect(opened.json().sync.trigger).toBe('started');
    await app.container.prSync.awaitRunning(repo.id);
    expect(github.listCalls).toBe(1);
    expect((await repoRow(repo.id)).lastSyncedAt?.getTime()).toBe(T0 + 61_000);

    clock = T0 + 91_000;
    const again = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/page` });
    expect(again.json().sync.trigger).toBe('fresh');
    expect(again.json().sync.state).toBe('idle');
    expect(again.json().sync.last_synced_at).toBe(new Date(T0 + 61_000).toISOString());
    expect(again.json().pulls.map((p: { number: number }) => p.number)).toEqual([482]);
    expect(github.listCalls).toBe(1);
  });

  it('a failing host: 10 opens → 1 attempt, state failed, last_synced_at unchanged (AC-25/62)', async () => {
    clock = T0 + 3_600_000;
    const lastGood = new Date(T0);
    const github = new ControlledGitHub('fail');
    const app = await makeApp({ github });
    const repo = await newRepo({ lastSyncedAt: lastGood, lastAttemptAt: lastGood }, [7]);

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/page` });
      expect(res.statusCode).toBe(200);
      expect(res.json().pulls).toHaveLength(1);
      await app.container.prSync.awaitRunning(repo.id);
    }
    expect(github.listCalls).toBe(1);

    const page = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/page` });
    expect(page.json().sync.trigger).toBe('fresh');
    expect(page.json().sync.state).toBe('failed');
    expect(page.json().sync.last_synced_at).toBe(lastGood.toISOString());
    expect(page.json().sync.last_sync_error).toMatch(/500/);
    const row = await repoRow(repo.id);
    expect(row.lastSyncedAt?.getTime()).toBe(lastGood.getTime());
    expect(row.lastSyncError).toMatch(/500/);

    // Back-off elapsed → the next open retries once.
    clock += 61_000;
    const retry = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/page` });
    expect(retry.json().sync.trigger).toBe('started');
    await app.container.prSync.awaitRunning(repo.id);
    expect(github.listCalls).toBe(2);
  });

  it('manual sync is single-flight: started, then joined ×4 → 1 host call (AC-57/58)', async () => {
    clock = T0;
    const github = new ControlledGitHub('gate');
    const app = await makeApp({ github });
    // Fresh within TTL — manual bypasses it.
    const repo = await newRepo({ lastSyncedAt: new Date(T0 - 1_000), lastAttemptAt: new Date(T0 - 1_000) });

    const first = await app.inject({ method: 'POST', url: `/repos/${repo.id}/pulls/sync` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ trigger: 'started' });
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'POST', url: `/repos/${repo.id}/pulls/sync` });
      expect(res.json()).toEqual({ trigger: 'joined' });
    }
    const opened = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/page` });
    expect(opened.json().sync.trigger).toBe('joined');

    await new Promise((r) => setTimeout(r, 10));
    expect(github.listCalls).toBe(1);
    github.release();
    await app.container.prSync.awaitRunning(repo.id);
    expect(github.listCalls).toBe(1);
  });

  it('SSE emits exactly one `done` event and ends — both when idle and when a sync completes', async () => {
    clock = T0;
    const github = new ControlledGitHub('gate');
    const app = await makeApp({ github });
    const repo = await newRepo();

    // Nothing running → one `done` snapshot, then the stream ends.
    const idle = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/sync/events` });
    expect(idle.statusCode).toBe(200);
    expect(idle.headers['content-type']).toMatch(/text\/event-stream/);
    expect(idle.body.match(/^event: done$/gm)).toHaveLength(1);

    // Running → waits for completion, emits one `done`, ends.
    expect((await app.inject({ method: 'POST', url: `/repos/${repo.id}/pulls/sync` })).json()).toEqual({
      trigger: 'started',
    });
    const streamed = app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/sync/events` });
    await new Promise((r) => setTimeout(r, 50));
    github.release();
    const res = await streamed;
    expect(res.body.match(/^event: done$/gm)).toHaveLength(1);
    const dataLine = res.body.split('\n').find((l) => l.startsWith('data: '))!;
    const event = JSON.parse(dataLine.slice('data: '.length));
    expect(event.state).toBe('idle');
    expect(event.last_synced_at).toBe(new Date(T0).toISOString());
    expect(event.last_sync_error).toBeNull();

    // Unknown repo → a normal 404 before any SSE handshake.
    const missing = await app.inject({
      method: 'GET',
      url: '/repos/00000000-0000-0000-0000-000000000000/pulls/sync/events',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('SSE still emits ONE terminal `done` (failed) when the status read rejects after the handshake', async () => {
    clock = T0;
    const app = await makeApp({ github: new ControlledGitHub('ok') });
    const syncedAt = new Date(T0 - 60_000);
    const repo = await newRepo({ lastSyncedAt: syncedAt });
    const spy = vi
      .spyOn(app.container.prSync, 'snapshot')
      .mockRejectedValue(new Error('connection terminated'));
    try {
      const res = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/sync/events` });
      expect(res.statusCode).toBe(200);
      expect(res.body.match(/^event: done$/gm)).toHaveLength(1);
      const dataLine = res.body.split('\n').find((l) => l.startsWith('data: '))!;
      expect(JSON.parse(dataLine.slice('data: '.length))).toEqual({
        state: 'failed',
        last_synced_at: syncedAt.toISOString(),
        last_sync_error: 'sync status unavailable',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('closing the SSE connection mid-sync does not cancel the sync (AC-64)', async () => {
    clock = T0 + 5_000;
    const github = new ControlledGitHub('gate');
    const app = await makeApp({ github });
    const repo = await newRepo();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    expect((await app.inject({ method: 'POST', url: `/repos/${repo.id}/pulls/sync` })).json().trigger).toBe(
      'started',
    );

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: `/repos/${repo.id}/pulls/sync/events`, method: 'GET' },
        (res) => {
          expect(res.statusCode).toBe(200);
          // Headers received → the stream is open; the client walks away.
          req.destroy();
          resolve();
        },
      );
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(app.container.prSync.isRunning(repo.id)).toBe(true);

    github.release();
    const done = await app.container.prSync.awaitRunning(repo.id);
    expect(done?.state).toBe('idle');
    const row = await repoRow(repo.id);
    expect(row.lastSyncedAt?.getTime()).toBe(T0 + 5_000);
    const prs = await pg.handle.db.select().from(t.pullRequests).where(eq(t.pullRequests.repoId, repo.id));
    expect(prs.map((p) => p.number)).toEqual([482]);
  });

  it('a GitHub PR DTO keeps the pre-change field set — no is_draft / stats_known keys (AC-60)', async () => {
    clock = T0;
    const github = new ControlledGitHub('ok');
    const app = await makeApp({ github });
    const repo = await newRepo();
    await app.inject({ method: 'POST', url: `/repos/${repo.id}/pulls/sync` });
    await app.container.prSync.awaitRunning(repo.id);

    const list = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls` });
    const [pr] = list.json();
    expect(Object.keys(pr).sort()).toEqual(GITHUB_DTO_KEYS);
    const page = await app.inject({ method: 'GET', url: `/repos/${repo.id}/pulls/page` });
    expect(Object.keys(page.json().pulls[0]).sort()).toEqual(GITHUB_DTO_KEYS);
  });

  it('a missing GitHub token fails only GitHub repos — the GitLab repo still syncs (AC-27)', async () => {
    clock = T0;
    const gitlab = new MockGitLabClient();
    const app = await makeApp({ github: null, gitlab });
    const ghRepo = await newRepo();
    const glRepo = await newRepo({
      owner: 'grp/sub',
      fullName: `grp/sub/list-${seq + 1}`,
      name: `list-${seq + 1}`,
      provider: 'gitlab',
      host: 'gitlab.com',
    });

    await app.inject({ method: 'POST', url: `/repos/${ghRepo.id}/pulls/sync` });
    await app.inject({ method: 'POST', url: `/repos/${glRepo.id}/pulls/sync` });
    const ghDone = await app.container.prSync.awaitRunning(ghRepo.id);
    const glDone = await app.container.prSync.awaitRunning(glRepo.id);
    expect(ghDone?.state).toBe('failed');
    expect(glDone?.state).toBe('idle');
    expect(gitlab.callsOf('merge_requests')).toHaveLength(1);

    const page = await app.inject({ method: 'GET', url: `/repos/${glRepo.id}/pulls/page` });
    const [mr] = page.json().pulls;
    expect(mr.number).toBe(5);
    expect(mr.is_draft).toBe(false);
    expect(mr.stats_known).toBe(true);
    expect(page.json().sync.state).toBe('idle');
  });

  it('POST /repos/:id/poll syncs through the coordinator and never triggers a review', async () => {
    clock = T0;
    const github = new ControlledGitHub('ok');
    const app = await makeApp({ github });
    const repo = await newRepo();

    const poll = await app.inject({ method: 'POST', url: `/repos/${repo.id}/poll` });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toEqual({ synced: 1, reviewTriggered: false });
    expect(github.listCalls).toBe(1);
    const row = await repoRow(repo.id);
    expect(row.lastPolledAt).not.toBeNull();
    expect(row.lastSyncedAt?.getTime()).toBe(T0);

    github.mode = 'fail';
    const failed = await app.inject({ method: 'POST', url: `/repos/${repo.id}/poll` });
    expect(failed.statusCode).toBe(502);
    expect(github.listCalls).toBe(2);
  });
});
