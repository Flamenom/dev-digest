import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HostComment } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockSecretsProvider } from '../src/adapters/mocks.js';
import { FakeGitLab, diffNote, textPosition, type FakeDiscussion } from './helpers/fake-gitlab.js';

/**
 * T7 — reading GitLab MR diff discussions through `GET /pulls/:id/comments`
 * (spec 2026-10-20-gitlab-comments AC-1 – AC-7): real `RestGitLabClient` over a
 * fake gitlab.com (`gitlabFetch`), Postgres for the PR row.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[pulls-comments-gitlab-read] Docker not available — skipping.');

const TOKEN = 'glpat-readSecretToken0000000002';
const SERVICE_ACCOUNT = 'devdigest-bot';
const HEAD = 'headaaaa';
const FOOTER = '\n\n— posted by `Olena Dev` via DevDigest';

d('GitLab MR comments: read (fake GitLab, Testcontainers pg)', () => {
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

  async function setup(discussions: FakeDiscussion[]) {
    seq += 1;
    const name = `mr-${seq}`;
    const fullPath = `gl-read/sub/${name}`;
    const fake = new FakeGitLab().addToken(TOKEN, SERVICE_ACCOUNT, ['api']);
    fake.addMr(fullPath, 9, { headSha: HEAD }).discussions.push(...discussions);
    const logs: string[] = [];
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db: pg.handle.db,
      logStream: { write: (line) => void logs.push(line) },
      overrides: {
        git: new MockGitClient(),
        secrets: new MockSecretsProvider({ GITLAB_TOKEN: TOKEN }),
        gitlabFetch: fake.fetch,
        github: new MockGitHubClient(),
      },
    });
    apps.push(app);
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'gl-read/sub', name, fullName: fullPath, provider: 'gitlab', host: 'gitlab.com' })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 9,
        title: 'Read comments',
        author: 'olena.dev',
        branch: 'feat/9',
        base: 'main',
        headSha: HEAD,
        detailHeadSha: HEAD,
        status: 'open',
      })
      .returning();
    const get = async () => {
      const res = await app.inject({ method: 'GET', url: `/pulls/${pr!.id}/comments` });
      expect(res.statusCode).toBe(200);
      return res.json() as HostComment[];
    };
    return { fake, logs, fullPath, get };
  }

  const at = (p: Parameters<typeof textPosition>[1]) => textPosition(HEAD, p);

  /** 2 surfaced discussions (3 notes) + every excluded kind. */
  function mixedDiscussions(): FakeDiscussion[] {
    return [
      {
        id: 'disc-a',
        individual_note: false,
        notes: [
          diffNote(101, 'reviewer', 'Root on an added line', at({ newPath: 'src/a.ts', newLine: 12 })),
          diffNote(102, 'author', 'A reply', null),
          diffNote(103, 'system', 'changed this line in version 2', null, { system: true }),
        ],
      },
      {
        id: 'disc-b',
        individual_note: false,
        notes: [diffNote(201, 'reviewer', 'On a removed line', at({ oldPath: 'src/b.ts', newPath: 'src/b.ts', oldLine: 4 }))],
      },
      // Excluded: an overview (individual) note, an image position, a file position,
      // a non-diff discussion and a system discussion.
      { id: 'disc-overview', individual_note: true, notes: [diffNote(301, 'x', 'LGTM', null, { type: null })] },
      {
        id: 'disc-image',
        individual_note: false,
        notes: [diffNote(401, 'x', 'image', { ...at({ newPath: 'logo.png', newLine: null }), position_type: 'image' })],
      },
      {
        id: 'disc-file',
        individual_note: false,
        notes: [diffNote(451, 'x', 'file', { ...at({ newPath: 'src/c.ts', newLine: null }), position_type: 'file' })],
      },
      { id: 'disc-plain', individual_note: false, notes: [diffNote(501, 'x', 'thread', null, { type: 'DiscussionNote' })] },
      {
        id: 'disc-system',
        individual_note: false,
        notes: [diffNote(601, 'x', 'added 1 commit', at({ newPath: 'src/a.ts', newLine: 1 }), { system: true })],
      },
    ];
  }

  it('AC-1: returns every note of every diff-anchored text discussion and nothing else (3 items)', async () => {
    const { get } = await setup(mixedDiscussions());
    const comments = await get();
    expect(comments.map((c) => c.id)).toEqual([101, 102, 201]);
  });

  it('AC-1: 150 discussions over 2 pages → all 150 returned', async () => {
    const many: FakeDiscussion[] = Array.from({ length: 150 }, (_, i) => ({
      id: `disc-${i}`,
      individual_note: false,
      notes: [diffNote(1_000 + i, 'reviewer', `note ${i}`, at({ newPath: 'src/a.ts', newLine: i + 1 }))],
    }));
    const { fake, get } = await setup(many);
    const comments = await get();
    expect(comments).toHaveLength(150);
    expect(new Set(comments.map((c) => c.id)).size).toBe(150);
    const pages = fake.matching(/\/merge_requests\/9\/discussions$/, 'GET');
    expect(pages.map((r) => r.query.page)).toEqual(['1', '2']);
  });

  it('AC-2: the first note is the thread root; later notes point at it; every note carries discussion_id', async () => {
    const { get } = await setup(mixedDiscussions());
    const byId = new Map((await get()).map((c) => [c.id, c]));
    expect(byId.get(101)).toMatchObject({ in_reply_to_id: null, discussion_id: 'disc-a' });
    expect(byId.get(102)).toMatchObject({ in_reply_to_id: 101, discussion_id: 'disc-a' });
    expect(byId.get(201)).toMatchObject({ in_reply_to_id: null, discussion_id: 'disc-b' });
  });

  it('AC-3: new_line → RIGHT@new_line; only old_line → LEFT@old_line (a reply inherits the root anchor)', async () => {
    const { get } = await setup(mixedDiscussions());
    const byId = new Map((await get()).map((c) => [c.id, c]));
    expect(byId.get(101)).toMatchObject({ side: 'RIGHT', line: 12, path: 'src/a.ts' });
    expect(byId.get(102)).toMatchObject({ side: 'RIGHT', line: 12, path: 'src/a.ts' });
    expect(byId.get(201)).toMatchObject({ side: 'LEFT', line: 4, path: 'src/b.ts' });
  });

  it('AC-4: a note anchored at another head → is_outdated true, line null', async () => {
    const { get } = await setup([
      {
        id: 'disc-old',
        individual_note: false,
        notes: [diffNote(701, 'reviewer', 'old', textPosition('oldhead0', { newPath: 'src/a.ts', newLine: 3 }))],
      },
    ]);
    const [c] = await get();
    expect(c).toMatchObject({ id: 701, is_outdated: true, line: null, original_line: 3 });
  });

  it('AC-5: html_url = <project web_url>/-/merge_requests/<iid>#note_<id>', async () => {
    const { fullPath, get } = await setup(mixedDiscussions());
    const [first] = await get();
    expect(first!.html_url).toBe(`https://gitlab.com/${fullPath}/-/merge_requests/9#note_101`);
  });

  it('AC-6: a GitLab 500 → 200 [] and the warning log carries no token', async () => {
    const { fake, logs, get } = await setup(mixedDiscussions());
    fake.when('GET', /\/discussions$/, { status: 500, headers: { 'retry-after': '0' }, body: { message: `boom ${TOKEN}` } }, 10);
    expect(await get()).toEqual([]);
    const text = logs.join('\n');
    expect(text).toMatch(/GitLab MR discussions fetch skipped/);
    expect(text).not.toContain(TOKEN);
  });

  it('AC-7: the service account\'s exact footer is stripped into devdigest_attribution; another author\'s footer is kept', async () => {
    const { get } = await setup([
      {
        id: 'disc-attr',
        individual_note: false,
        notes: [
          diffNote(801, SERVICE_ACCOUNT, `Extract this.${FOOTER}`, at({ newPath: 'src/a.ts', newLine: 2 })),
          diffNote(802, 'mallory', `Typed by hand.${FOOTER}`, null),
        ],
      },
    ]);
    const byId = new Map((await get()).map((c) => [c.id, c]));
    expect(byId.get(801)).toMatchObject({ body: 'Extract this.', devdigest_attribution: { name: 'Olena Dev' } });
    expect(byId.get(802)!.body).toBe(`Typed by hand.${FOOTER}`);
    expect(byId.get(802)!.devdigest_attribution ?? null).toBeNull();
  });
});
