import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import { GITLAB_FIXTURE_FULL_NAME } from '../src/db/seed-gitlab.js';
import * as t from '../src/db/schema.js';

/**
 * T16 — the opt-in GitLab seed fixture. Each case gets a fresh container so the
 * "without the flag" assertion is not polluted by a previous flagged run.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const FLAG = 'SEED_GITLAB_FIXTURE';

d('seed — GitLab fixture (SEED_GITLAB_FIXTURE)', () => {
  let pg: PgFixture | undefined;
  const prevFlag = process.env[FLAG];

  beforeAll(() => {
    delete process.env[FLAG];
  });
  afterEach(async () => {
    delete process.env[FLAG];
    await pg?.stop();
    pg = undefined;
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
  });

  it('with the flag, seeding twice yields exactly 1 GitLab repo and 2 MRs with the fixture shape', async () => {
    pg = await startPg();
    const db = pg.handle.db;
    process.env[FLAG] = '1';
    await seed(db);
    await seed(db);

    const gitlabRepos = await db.select().from(t.repos).where(eq(t.repos.provider, 'gitlab'));
    expect(gitlabRepos).toHaveLength(1);
    const repo = gitlabRepos[0]!;
    expect(repo).toMatchObject({
      host: 'gitlab.com',
      fullName: GITLAB_FIXTURE_FULL_NAME,
      owner: 'space-profit/platform',
      name: 'crm-frontend',
    });
    expect(repo.lastSyncedAt).toBeInstanceOf(Date);

    // GitHub demo repo stays the oldest (first) repo.
    const ordered = await db.select().from(t.repos).orderBy(asc(t.repos.createdAt));
    expect(ordered[0]!.fullName).toBe('acme/payments-api');
    expect(ordered[0]!.provider).toBe('github');

    const prs = await db
      .select()
      .from(t.pullRequests)
      .where(eq(t.pullRequests.repoId, repo.id))
      .orderBy(asc(t.pullRequests.number));
    expect(prs.map((p) => p.number)).toEqual([5, 6]);
    const [mr5, mr6] = prs;
    expect(mr5).toMatchObject({ isDraft: true, statsKnown: true, detailHeadSha: mr5!.headSha });
    expect(mr6).toMatchObject({ statsKnown: false });

    const files = await db.select().from(t.prFiles).where(eq(t.prFiles.prId, mr5!.id));
    expect(files).toHaveLength(3);
    const renamed = files.find((f) => f.previousPath != null);
    expect(renamed).toMatchObject({ changeType: 'renamed', previousPath: 'src/components/ContactCard.vue' });
    const omitted = files.find((f) => f.patchOmitted != null);
    expect(omitted).toMatchObject({ patchOmitted: 'too_large', patch: null });
    const normal = files.filter((f) => f.previousPath == null && f.patchOmitted == null);
    expect(normal).toHaveLength(1);
    expect(normal[0]!.patch).toMatch(/^@@ /);

    const commits = await db.select().from(t.prCommits).where(eq(t.prCommits.prId, mr5!.id));
    expect(commits).toHaveLength(2);
    const allMrIds = prs.map((p) => p.id);
    const allFiles = await db.select().from(t.prFiles).where(inArray(t.prFiles.prId, allMrIds));
    expect(allFiles).toHaveLength(3); // !6 is list-only — no files
  }, 180_000);

  it('without the flag, no GitLab rows are seeded', async () => {
    pg = await startPg();
    const db = pg.handle.db;
    await seed(db);

    const gitlabRepos = await db.select().from(t.repos).where(eq(t.repos.provider, 'gitlab'));
    expect(gitlabRepos).toHaveLength(0);
    const byName = await db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.fullName, GITLAB_FIXTURE_FULL_NAME)));
    expect(byName).toHaveLength(0);
  }, 180_000);
});
