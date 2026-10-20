import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { HostComment } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockSecretsProvider } from '../src/adapters/mocks.js';
import { auditWritesSettled } from '../src/platform/auth/audit-hook.js';
import {
  anonymous,
  asSession,
  buildGoogleApp,
  type GoogleTestApp,
  type SessionCredential,
} from './helpers/google-mode.js';
import { FakeGitLab, diffNote, textPosition } from './helpers/fake-gitlab.js';

/**
 * T7 — attribution of posted comments in google mode (spec
 * 2026-10-20-gitlab-comments AC-16, AC-17, AC-41, AC-42): the `pr_comment.create`
 * audit row (ids and flags only, never the body), the GitLab attribution footer,
 * and access (Member may post, no session → 401 with no host call). GitLab is a
 * fake gitlab.com over `gitlabFetch`; GitHub is the real Octokit client over a
 * recording `githubFetch`.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[pr-comment-audit] Docker not available — skipping.');

const GITLAB_TOKEN = 'glpat-auditSecretToken00000007';
const GITHUB_TOKEN = 'ghp_auditSecretGithubToken0000008';
const SERVICE_ACCOUNT = 'devdigest-bot';
const HEAD = 'audithead';
const GL_PATH = 'gl-audit/payments';

/** Records GitHub REST calls; answers comment creates with a fixed comment. */
function fakeGitHub() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    if (init?.method === 'POST' && /\/pulls\/7\/comments$/.test(url)) {
      return new Response(
        JSON.stringify({
          id: 4242,
          path: 'src/config.ts',
          line: 11,
          original_line: 11,
          side: 'RIGHT',
          body: (body as { body: string }).body,
          user: { login: 'octo-bot' },
          created_at: '2026-10-20T00:00:00Z',
          html_url: 'https://github.com/gh-audit/svc/pull/7#discussion_r4242',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

d('pr_comment.create audit + attribution (google mode, Testcontainers pg)', () => {
  let pg: PgFixture;
  let app: GoogleTestApp;
  let fake: FakeGitLab;
  let gh: ReturnType<typeof fakeGitHub>;
  let member: SessionCredential;
  let memberId: string;
  let glPrId: string;
  let ghPrId: string;

  beforeAll(async () => {
    pg = await startPg();
    fake = new FakeGitLab().addToken(GITLAB_TOKEN, SERVICE_ACCOUNT, ['api']);
    fake.addMr(GL_PATH, 5, { headSha: HEAD }).discussions.push({
      id: 'disc-root',
      individual_note: false,
      notes: [diffNote(501, 'reviewer', 'Why?', textPosition(HEAD, { newPath: 'src/main.ts', newLine: 2 }))],
    });
    gh = fakeGitHub();
    app = await buildGoogleApp({
      pg,
      overrides: {
        git: new MockGitClient(),
        secrets: new MockSecretsProvider({ GITLAB_TOKEN, GITHUB_TOKEN }),
        gitlabFetch: fake.fetch,
        githubFetch: gh.impl,
      },
    });
    const user = await app.createUser({ name: 'Olena Dev', role: 'member' });
    memberId = user.userId;
    member = await app.signIn(user);

    const db = app.db;
    const [glRepo] = await db
      .insert(t.repos)
      .values({
        workspaceId: app.workspaceId,
        owner: 'gl-audit',
        name: 'payments',
        fullName: GL_PATH,
        provider: 'gitlab',
        host: 'gitlab.com',
      })
      .returning();
    const [glPr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId: app.workspaceId,
        repoId: glRepo!.id,
        number: 5,
        title: 'GitLab MR',
        author: 'olena.dev',
        branch: 'feat/5',
        base: 'main',
        headSha: HEAD,
        detailHeadSha: HEAD,
        status: 'open',
      })
      .returning();
    glPrId = glPr!.id;
    await db.insert(t.prFiles).values({
      prId: glPrId,
      path: 'src/main.ts',
      additions: 2,
      patch: '@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;',
    });

    const [ghRepo] = await db
      .insert(t.repos)
      .values({ workspaceId: app.workspaceId, owner: 'gh-audit', name: 'svc', fullName: 'gh-audit/svc' })
      .returning();
    const [ghPr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId: app.workspaceId,
        repoId: ghRepo!.id,
        number: 7,
        title: 'GitHub PR',
        author: 'octo',
        branch: 'feat/7',
        base: 'main',
        headSha: 'deadbeef',
        status: 'open',
      })
      .returning();
    ghPrId = ghPr!.id;
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  const postAs = (cred: SessionCredential, prId: string, payload: Record<string, unknown>) =>
    app.app.inject(asSession(cred, { method: 'POST', url: `/pulls/${prId}/comments`, payload }));

  async function commentAuditRows() {
    await auditWritesSettled(app.app);
    return app.db.select().from(t.auditEvents).where(eq(t.auditEvents.action, 'pr_comment.create'));
  }

  const BODIES = {
    reply: 'Reply body that must never reach the audit log',
    github: 'GitHub body that must never reach the audit log',
    footer: 'Footer body that must never reach the audit log',
  };

  it('AC-41 + AC-42: a Member GitLab reply → 200 and ONE pr_comment.create row (is_reply, discussion_id), no body', async () => {
    const res = await postAs(member, glPrId, { path: 'src/main.ts', line: 2, body: BODIES.reply, discussion_id: 'disc-root' });
    expect(res.statusCode).toBe(200);
    const reply = res.json() as HostComment;
    expect(reply.in_reply_to_id).toBe(501);

    const rows = await commentAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: app.workspaceId,
      actorUserId: memberId,
      action: 'pr_comment.create',
      targetType: 'pull_request',
      targetId: glPrId,
    });
    expect(rows[0]!.metadata).toEqual({
      provider: 'gitlab',
      host_comment_id: reply.id,
      discussion_id: 'disc-root',
      is_reply: true,
    });
  });

  it('AC-42 + AC-17: a GitHub comment → ONE row (provider github, is_reply false); body forwarded without a footer', async () => {
    const res = await postAs(member, ghPrId, { path: 'src/config.ts', line: 11, body: BODIES.github });
    expect(res.statusCode).toBe(200);
    const writes = gh.calls.filter((c) => c.method === 'POST');
    expect(writes).toHaveLength(1);
    expect((writes[0]!.body as { body: string }).body).toBe(BODIES.github);

    const rows = (await commentAuditRows()).filter((r) => r.targetId === ghPrId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({ provider: 'github', host_comment_id: 4242, is_reply: false });
  });

  it('AC-16: google mode + GitLab → the posted text ends with the attribution footer; read back as devdigest_attribution', async () => {
    fake.reset();
    const res = await postAs(member, glPrId, { path: 'src/main.ts', line: 1, body: BODIES.footer });
    expect(res.statusCode).toBe(200);
    const sent = (fake.writes[0]!.body as { body: string }).body;
    expect(sent).toBe(`${BODIES.footer}\n\n— posted by \`Olena Dev\` via DevDigest`);
    expect(res.json()).toMatchObject({ body: BODIES.footer, devdigest_attribution: { name: 'Olena Dev' } });
  });

  it('AC-42: a failed post → 0 new audit rows', async () => {
    const before = (await commentAuditRows()).length;
    fake.when('POST', /\/discussions$/, { status: 502 }, 5);
    const res = await postAs(member, glPrId, { path: 'src/main.ts', line: 2, body: 'will fail' });
    expect(res.statusCode).toBe(502);
    expect((await commentAuditRows()).length).toBe(before);
  });

  it('AC-42: a DB scan of audit_events finds no comment body text', async () => {
    await auditWritesSettled(app.app);
    const rows = await app.db.execute<{ row: string }>(sql`select row_to_json(a)::text as row from audit_events a`);
    const dump = [...rows].map((r) => r.row).join('\n');
    expect(dump).toContain('pr_comment.create');
    for (const body of Object.values(BODIES)) expect(dump).not.toContain(body);
    expect(dump).not.toContain('must never reach');
  });

  it('AC-41: no session → 401 and 0 requests to either host', async () => {
    fake.reset();
    const ghBefore = gh.calls.length;
    for (const prId of [glPrId, ghPrId]) {
      const res = await app.app.inject(
        anonymous({ method: 'POST', url: `/pulls/${prId}/comments`, payload: { path: 'src/main.ts', line: 2, body: 'x' } }),
      );
      expect(res.statusCode).toBe(401);
    }
    expect(fake.requests).toEqual([]);
    expect(gh.calls.length).toBe(ghBefore);
  });
});
