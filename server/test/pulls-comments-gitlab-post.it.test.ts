import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HostComment } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockSecretsProvider } from '../src/adapters/mocks.js';
import { FakeGitLab, diffNote, quickActionMatches, rawCommandLines, textPosition } from './helpers/fake-gitlab.js';

/**
 * T7 — posting GitLab MR comments and replies end to end: real routes, real
 * `PrCommentsService`, real `RestGitLabClient` over a fake gitlab.com
 * (`gitlabFetch` override), Postgres for the PR + persisted diff (spec
 * 2026-10-20-gitlab-comments AC-8 – AC-20, AC-29 – AC-31, AC-14). Local auth
 * mode ⇒ no attribution footer (AC-17); the google-mode footer (AC-16) is in
 * pr-comment-audit.it.test.ts.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[pulls-comments-gitlab-post] Docker not available — skipping.');

const TOKEN = 'glpat-postSecretToken000000001';
const SERVICE_ACCOUNT = 'devdigest-bot';
const HEAD = 'head1111';
const UNCONFIRMED = "GitLab didn't confirm the comment — check the MR before posting again.";

/** ctx@1/1, removed old 2, added new 2, ctx@3/3 */
const MAIN_PATCH = '@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;';

d('GitLab MR comments: post + reply (fake GitLab, Testcontainers pg)', () => {
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

  async function setup(opts: { token?: string | null; mrHead?: string } = {}) {
    const token = opts.token === undefined ? TOKEN : opts.token;
    seq += 1;
    const name = `mr-${seq}`;
    const fullPath = `gl-post/${name}`;
    const fake = new FakeGitLab().addToken(TOKEN, SERVICE_ACCOUNT, ['api', 'read_user']);
    fake.addMr(fullPath, 5, { baseSha: 'base5', startSha: 'start5', headSha: opts.mrHead ?? HEAD });
    const github = new MockGitHubClient();
    const logs: string[] = [];
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db: pg.handle.db,
      logStream: { write: (line) => void logs.push(line) },
      overrides: {
        git: new MockGitClient(),
        secrets: new MockSecretsProvider(token ? { GITLAB_TOKEN: token } : {}),
        gitlabFetch: fake.fetch,
        github,
      },
    });
    apps.push(app);

    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'gl-post', name, fullName: fullPath, provider: 'gitlab', host: 'gitlab.com' })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 5,
        title: 'Add CRM contact import',
        author: 'olena.dev',
        branch: 'feat/5',
        base: 'main',
        headSha: HEAD,
        detailHeadSha: HEAD,
        status: 'open',
      })
      .returning();
    await pg.handle.db.insert(t.prFiles).values([
      { prId: pr!.id, path: 'src/main.ts', additions: 1, deletions: 1, patch: MAIN_PATCH },
      {
        prId: pr!.id,
        path: 'src/new-name.ts',
        previousPath: 'src/old-name.ts',
        changeType: 'renamed',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n x\n+y',
      },
      { prId: pr!.id, path: 'src/added.ts', changeType: 'added', additions: 1, patch: '@@ -0,0 +1,1 @@\n+fresh' },
      { prId: pr!.id, path: 'src/deleted.ts', changeType: 'deleted', deletions: 1, patch: '@@ -1,1 +0,0 @@\n-gone' },
      { prId: pr!.id, path: 'src/huge.ts', additions: 900, patch: null, patchOmitted: 'too_large' },
    ]);
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/pulls/${pr!.id}/comments`, payload });
    return { app, fake, github, logs, pr: pr!, fullPath, post };
  }

  const discussionWrites = (fake: FakeGitLab) => fake.writes.filter((r) => /\/discussions$/.test(r.path));

  it('AC-8: a new comment → ONE create-discussion request with a text position at the CURRENT refs; response in the read shape', async () => {
    const { fake, fullPath, post } = await setup();
    const res = await post({ path: 'src/main.ts', line: 2, side: 'RIGHT', body: 'Please extract this.' });
    expect(res.statusCode).toBe(200);

    expect(fake.writes).toHaveLength(1);
    const write = fake.writes[0]!;
    expect(write.path).toBe(`/api/v4/projects/${encodeURIComponent(fullPath)}/merge_requests/5/discussions`);
    expect(write.body).toEqual({
      body: 'Please extract this.',
      position: {
        position_type: 'text',
        base_sha: 'base5',
        start_sha: 'start5',
        head_sha: HEAD,
        old_path: 'src/main.ts',
        new_path: 'src/main.ts',
        new_line: 2,
      },
    });

    const created = res.json() as HostComment;
    expect(created).toMatchObject({
      path: 'src/main.ts',
      line: 2,
      side: 'RIGHT',
      body: 'Please extract this.',
      user: SERVICE_ACCOUNT,
      in_reply_to_id: null,
      is_outdated: false,
      provider: 'gitlab',
    });
    expect(created.discussion_id).toBeTruthy();
  });

  it('AC-9: context line → old_line + new_line; added → new_line; removed → old_line', async () => {
    const { fake, post } = await setup();
    expect((await post({ path: 'src/main.ts', line: 1, side: 'RIGHT', body: 'ctx' })).statusCode).toBe(200);
    expect((await post({ path: 'src/main.ts', line: 2, side: 'RIGHT', body: 'added' })).statusCode).toBe(200);
    expect((await post({ path: 'src/main.ts', line: 2, side: 'LEFT', body: 'removed' })).statusCode).toBe(200);

    const positions = discussionWrites(fake).map((w) => (w.body as { position: Record<string, unknown> }).position);
    expect(positions).toHaveLength(3);
    expect(positions[0]).toMatchObject({ old_line: 1, new_line: 1 });
    expect(positions[1]).toMatchObject({ new_line: 2 });
    expect(positions[1]).not.toHaveProperty('old_line');
    expect(positions[2]).toMatchObject({ old_line: 2 });
    expect(positions[2]).not.toHaveProperty('new_line');
  });

  it('AC-10: a renamed file sends old_path = previous path and new_path = current path', async () => {
    const { fake, post } = await setup();
    const res = await post({ path: 'src/new-name.ts', line: 2, body: 'renamed' });
    expect(res.statusCode).toBe(200);
    expect((discussionWrites(fake)[0]!.body as { position: unknown }).position).toMatchObject({
      old_path: 'src/old-name.ts',
      new_path: 'src/new-name.ts',
      new_line: 2,
    });
  });

  it('AC-11: a target outside the persisted diff → 400 comment_position_invalid with 0 GitLab requests (5 cases)', async () => {
    const { fake, post } = await setup();
    const cases = [
      { path: 'src/absent.ts', line: 1, body: 'file not in diff' },
      { path: 'src/huge.ts', line: 1, body: 'patch withheld by the host' },
      { path: 'src/main.ts', line: 40, body: 'line outside every hunk' },
      { path: 'src/added.ts', line: 1, side: 'LEFT', body: 'LEFT on an added file' },
      { path: 'src/deleted.ts', line: 1, side: 'RIGHT', body: 'RIGHT on a deleted file' },
    ];
    for (const payload of cases) {
      const res = await post(payload);
      expect(res.statusCode, payload.body).toBe(400);
      expect(res.json().error.code, payload.body).toBe('comment_position_invalid');
    }
    expect(fake.requests).toEqual([]);
  });

  it('AC-12: head moved → 409 comment_diff_outdated after 1 MR read and 0 writes (new comment and reply)', async () => {
    const { fake, fullPath, post } = await setup({ mrHead: 'head2222' });
    fake.mr(fullPath, 5).discussions.push({
      id: 'disc-x',
      individual_note: false,
      notes: [diffNote(501, 'reviewer', 'root', textPosition(HEAD, { newPath: 'src/main.ts', newLine: 2 }))],
    });

    const res = await post({ path: 'src/main.ts', line: 2, body: 'stale' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'comment_diff_outdated',
      message: 'New commits were pushed — reload the diff',
    });
    expect(fake.matching(/\/merge_requests\/5$/, 'GET')).toHaveLength(1);

    const reply = await post({ path: 'src/main.ts', line: 2, body: 'stale reply', discussion_id: 'disc-x' });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('comment_diff_outdated');
    expect(fake.writes).toHaveLength(0);
  });

  it('AC-12: head equal → 1 MR read then 1 write anchored at the refs just read', async () => {
    const { fake, post } = await setup();
    const res = await post({ path: 'src/main.ts', line: 3, body: 'fresh' });
    expect(res.statusCode).toBe(200);
    const mrReads = fake.matching(/\/merge_requests\/5$/, 'GET');
    expect(mrReads).toHaveLength(1);
    expect(fake.writes).toHaveLength(1);
    expect(fake.requests.indexOf(mrReads[0]!)).toBeLessThan(fake.requests.indexOf(fake.writes[0]!));
    expect((fake.writes[0]!.body as { position: unknown }).position).toMatchObject({
      base_sha: 'base5',
      start_sha: 'start5',
      head_sha: HEAD,
    });
  });

  it('AC-13: the text GitLab receives has no command-shaped line; removing the inserted marks restores it', async () => {
    const { fake, post } = await setup();
    const typed = '/merge\n/close\nLGTM\n  /label ~x\n```\n/approve\n```';
    const res = await post({ path: 'src/main.ts', line: 2, body: typed });
    expect(res.statusCode).toBe(200);

    const sent = (fake.writes[0]!.body as { body: string }).body;
    // Security property, parser-independent: no raw line matches `^\/<name>…`.
    expect(rawCommandLines(typed)).toEqual(['/merge', '/close', '/approve']);
    expect(rawCommandLines(sent)).toEqual([]);
    // Secondary: the extractor model runs commands on the typed text, none on the sent text.
    expect(quickActionMatches(typed)).toEqual(['merge', 'close']);
    expect(quickActionMatches(sent)).toEqual([]);
    // Inside the fence only an invisible U+200B precedes the `/`.
    expect(sent.endsWith('```\n\u200B/approve\n```')).toBe(true);
    expect(sent.replace(/[\\\u200B]\//g, '/')).toBe(typed);
  });

  it('AC-14: a whitespace-only body → 400 on GitLab AND GitHub, with no host call', async () => {
    const { fake, github, post, pr } = await setup();
    const gl = await post({ path: 'src/main.ts', line: 2, body: '  \n\t ' });
    expect(gl.statusCode).toBe(400);
    expect(gl.json().error.code).toBe('validation_error');
    expect(fake.requests).toEqual([]);

    // A GitHub PR in the same workspace (MockGitHubClient records creates).
    seq += 1;
    const [ghRepo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'gh-post', name: `gh-${seq}`, fullName: `gh-post/gh-${seq}` })
      .returning();
    const [ghPr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: ghRepo!.id,
        number: 7,
        title: 'gh',
        author: 'a',
        branch: 'b',
        base: 'main',
        headSha: 'deadbeef',
        status: 'open',
      })
      .returning();
    const app = apps.at(-1)!;
    const gh = await app.inject({
      method: 'POST',
      url: `/pulls/${ghPr!.id}/comments`,
      payload: { path: 'src/config.ts', line: 11, body: '   ' },
    });
    expect(gh.statusCode).toBe(400);
    expect(gh.json().error.code).toBe('validation_error');
    expect(github.createdComments).toEqual([]);
    expect(pr.id).not.toBe(ghPr!.id);
  });

  it('AC-15: posted text over 1,000,000 chars → 400 comment_too_long with 0 GitLab requests; exactly 1,000,000 is accepted', async () => {
    const { fake, post } = await setup();
    const tooLong = await post({ path: 'src/main.ts', line: 2, body: 'a'.repeat(1_000_001) });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe('comment_too_long');
    expect(fake.requests).toEqual([]);

    const atLimit = await post({ path: 'src/main.ts', line: 2, body: 'é'.repeat(1_000_000) });
    expect(atLimit.statusCode).toBe(200);
    expect(fake.writes).toHaveLength(1);
  });

  it('AC-17: local auth mode → the body is sent without an attribution footer', async () => {
    const { fake, post } = await setup();
    const res = await post({ path: 'src/main.ts', line: 2, body: 'No footer here.' });
    expect(res.statusCode).toBe(200);
    expect((fake.writes[0]!.body as { body: string }).body).toBe('No footer here.');
    expect((res.json() as HostComment).devdigest_attribution ?? null).toBeNull();
  });

  it('AC-19: a reply → ONE add-note request to that discussion; in_reply_to_id = root note id', async () => {
    const { fake, fullPath, post } = await setup();
    fake.mr(fullPath, 5).discussions.push({
      id: 'disc-root',
      individual_note: false,
      notes: [diffNote(501, 'reviewer', 'Why?', textPosition(HEAD, { newPath: 'src/main.ts', newLine: 2 }))],
    });

    const res = await post({ path: 'src/main.ts', line: 2, body: 'Because.', discussion_id: 'disc-root' });
    expect(res.statusCode).toBe(200);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]!.path).toMatch(/\/merge_requests\/5\/discussions\/disc-root\/notes$/);
    expect(fake.writes[0]!.body).toEqual({ body: 'Because.' });
    // The discussion is looked up before the write (existence + root id, Q3).
    const lookup = fake.matching(/\/discussions\/disc-root$/, 'GET');
    expect(lookup).toHaveLength(1);
    expect(fake.requests.indexOf(lookup[0]!)).toBeLessThan(fake.requests.indexOf(fake.writes[0]!));

    expect(res.json()).toMatchObject({
      in_reply_to_id: 501,
      discussion_id: 'disc-root',
      path: 'src/main.ts',
      line: 2,
      side: 'RIGHT',
      body: 'Because.',
      user: SERVICE_ACCOUNT,
    });
  });

  it('AC-20: a reply to a missing discussion → 404 comment_thread_not_found, 0 notes created', async () => {
    const { fake, post } = await setup();
    const res = await post({ path: 'src/main.ts', line: 2, body: 'hello?', discussion_id: 'gone-123' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('comment_thread_not_found');
    expect(fake.writes).toHaveLength(0);
  });

  it('AC-29: no GitLab token → 400 gitlab_token_missing with 0 GitLab requests', async () => {
    const { fake, post } = await setup({ token: null });
    const res = await post({ path: 'src/main.ts', line: 2, body: 'hi' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('gitlab_token_missing');
    expect(fake.requests).toEqual([]);
  });

  it('AC-29: a 401 → gitlab_token_invalid, and secrets-status reports gitlab_health invalid', async () => {
    const { app, fake, post } = await setup();
    fake.when('GET', /\/merge_requests\/5$/, { status: 401, body: { message: '401 Unauthorized' } });
    const res = await post({ path: 'src/main.ts', line: 2, body: 'hi' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('gitlab_token_invalid');
    expect(fake.writes).toHaveLength(0);

    const status = await app.inject({ method: 'GET', url: '/settings/secrets-status' });
    expect(status.statusCode).toBe(200);
    expect(status.json().gitlab_health).toBe('invalid');
  });

  it('AC-30: a locked discussion (403) → gitlab_comment_failed; no token substring in the response or logs', async () => {
    const { fake, logs, post } = await setup();
    fake.when('POST', /\/discussions$/, {
      status: 403,
      body: { message: `403 Forbidden - discussion is locked (token ${TOKEN})` },
    });
    const res = await post({ path: 'src/main.ts', line: 2, body: 'locked?' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('gitlab_comment_failed');
    expect(res.json().error.message).toMatch(/locked/);
    expect(res.payload).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(fake.writes).toHaveLength(1);
  });

  it('AC-31: 429 then 201 → 2 writes and success', async () => {
    const { fake, post } = await setup();
    fake.when('POST', /\/discussions$/, { status: 429, headers: { 'retry-after': '0' } });
    const res = await post({ path: 'src/main.ts', line: 2, body: 'rate limited once' });
    expect(res.statusCode).toBe(200);
    expect(discussionWrites(fake)).toHaveLength(2);
  });

  it('AC-31: a 502 on the write → exactly 1 write, then gitlab_comment_failed "didn\'t confirm"', async () => {
    const { fake, post } = await setup();
    fake.when('POST', /\/discussions$/, { status: 502, headers: { 'retry-after': '0' } }, 5);
    const res = await post({ path: 'src/main.ts', line: 2, body: 'maybe landed' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'gitlab_comment_failed', message: UNCONFIRMED });
    expect(discussionWrites(fake)).toHaveLength(1);
  });

  it('AC-31: a timeout on the write → exactly 1 write, then gitlab_comment_failed "didn\'t confirm"', async () => {
    const { fake, post } = await setup();
    fake.when('POST', /\/discussions$/, 'timeout', 5);
    const res = await post({ path: 'src/main.ts', line: 2, body: 'timed out' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'gitlab_comment_failed', message: UNCONFIRMED });
    expect(discussionWrites(fake)).toHaveLength(1);
  });

  it('AC-1 – AC-7: the POST response equals the same comment read back through GET (read shape)', async () => {
    const { app, fake, pr, fullPath, post } = await setup();
    fake.mr(fullPath, 5).discussions.push({
      id: 'disc-rt',
      individual_note: false,
      notes: [diffNote(601, 'reviewer', 'Root', textPosition(HEAD, { newPath: 'src/main.ts', newLine: 1, oldLine: 1 }))],
    });
    const created = (await post({ path: 'src/main.ts', line: 2, side: 'LEFT', body: 'New thread' })).json() as HostComment;
    const reply = (await post({ path: 'src/main.ts', line: 1, body: 'A reply', discussion_id: 'disc-rt' })).json() as HostComment;

    const listed = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/comments` })).json() as HostComment[];
    expect(listed.find((c) => c.id === created.id)).toEqual(created);
    expect(listed.find((c) => c.id === reply.id)).toEqual(reply);
    expect(created).toMatchObject({
      side: 'LEFT',
      line: 2,
      html_url: `https://gitlab.com/${fullPath}/-/merge_requests/5#note_${created.id}`,
    });
  });
});
