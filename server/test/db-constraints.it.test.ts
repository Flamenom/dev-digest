import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, inArray } from 'drizzle-orm';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import { seedGitlabFixture } from '../src/db/seed-gitlab.js';
import * as t from '../src/db/schema.js';
import { RepoRepository, type InsertRepo } from '../src/modules/repos/repository.js';

/**
 * Migration 0020 — DB hardening from the GitLab PR review:
 *   - pr_files.change_type / patch_omitted CHECKs, repos.host = lower(host) CHECK;
 *   - repo identity split into two disjoint partial unique indexes (GitLab on
 *     lower(full_name), everything else exact) and RepoRepository.insert scoped to them;
 *   - the GitLab seed fixture written in one transaction (idempotent re-run);
 *   - 0020's data guards: dirty host/enum rows are normalised; GitLab case-only
 *     duplicates ABORT the migration (no user data is deleted).
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('migration 0020 — constraints & repo identity', () => {
  let pg: PgFixture;
  let sql: postgres.Sql;
  let repos: RepoRepository;
  let workspaceId: string;
  let userId: string;
  let prId: string;

  beforeAll(async () => {
    pg = await startPg();
    sql = pg.handle.sql;
    repos = new RepoRepository(pg.handle.db);
    ({ workspaceId, userId } = await seed(pg.handle.db));
    const [r] = await sql`
      INSERT INTO repos (workspace_id, owner, name, full_name)
      VALUES (${workspaceId}, 'ck', 'files', 'ck/files') RETURNING id`;
    const [p] = await sql`
      INSERT INTO pull_requests (workspace_id, repo_id, number, title, author, branch, base, head_sha)
      VALUES (${workspaceId}, ${r!.id}, 1, 'pr', 'octo', 'feat', 'main', 'sha') RETURNING id`;
    prId = p!.id as string;
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  const insertFile = (changeType: string | null, patchOmitted: string | null) => sql`
    INSERT INTO pr_files (pr_id, path, change_type, patch_omitted)
    VALUES (${prId}, 'a.ts', ${changeType}, ${patchOmitted})`;

  const insertRepo = (provider: string, host: string, fullName: string) => {
    const [owner, ...rest] = fullName.split('/');
    return sql`
      INSERT INTO repos (workspace_id, owner, name, full_name, provider, host)
      VALUES (${workspaceId}, ${owner!}, ${rest.join('/')}, ${fullName}, ${provider}, ${host})`;
  };

  it('pr_files CHECKs accept the allowed sets + NULL and reject anything else (23514)', async () => {
    for (const ct of ['added', 'modified', 'deleted', 'renamed', null]) await insertFile(ct, null);
    for (const po of ['too_large', 'collapsed', null]) await insertFile(null, po);

    await expect(insertFile('copied', null)).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'pr_files_change_type_ck',
    });
    await expect(insertFile(null, 'binary')).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'pr_files_patch_omitted_ck',
    });
  });

  it('repos.host must be lower-case (23514)', async () => {
    await expect(insertRepo('gitlab', 'GitLab.com', 'ck/host-case')).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'repos_host_lower_ck',
    });
  });

  it('GitLab identity is case-insensitive on full_name; GitHub stays exact', async () => {
    await insertRepo('gitlab', 'gitlab.com', 'Grp/Sub/Proj');
    await expect(insertRepo('gitlab', 'gitlab.com', 'grp/sub/proj')).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'repos_gitlab_ws_host_lower_fullname_uq',
    });
    // Same path on another GitLab host is a different repo.
    await insertRepo('gitlab', 'gitlab.example.com', 'grp/sub/proj');

    // GitHub: case-only variants were (and still are) allowed; exact duplicates are not.
    await insertRepo('github', 'github.com', 'Acme/Case');
    await insertRepo('github', 'github.com', 'acme/case');
    await expect(insertRepo('github', 'github.com', 'acme/case')).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'repos_ws_provider_host_fullname_uq',
    });
  });

  it('RepoRepository.insert: concurrent adds return exactly one row, losers get undefined (no raw error)', async () => {
    const base = { workspaceId, createdBy: userId };
    const gitlab = (fullName: string): InsertRepo => ({
      ...base,
      owner: fullName.split('/').slice(0, -1).join('/'),
      name: fullName.split('/').at(-1)!,
      fullName,
      provider: 'gitlab',
      host: 'gitlab.com',
    });
    const glResults = await Promise.all(
      ['Race/Grp/App', 'race/grp/app', 'RACE/GRP/APP', 'race/Grp/app', 'Race/Grp/App'].map((n) =>
        repos.insert(gitlab(n)),
      ),
    );
    const glWinners = glResults.filter((r) => r !== undefined);
    expect(glWinners).toHaveLength(1);
    expect(glWinners[0]).toMatchObject({ provider: 'gitlab', host: 'gitlab.com', defaultBranch: 'main' });
    expect(glWinners[0]!.createdAt).toBeInstanceOf(Date);
    // The loser path (service re-read) resolves the winner for any casing.
    const found = await repos.findByIdentity(workspaceId, {
      provider: 'gitlab',
      host: 'gitlab.com',
      fullName: 'race/grp/APP',
    });
    expect(found?.id).toBe(glWinners[0]!.id);

    const github: InsertRepo = { ...base, owner: 'race', name: 'gh', fullName: 'race/gh' };
    const ghResults = await Promise.all(Array.from({ length: 5 }, () => repos.insert(github)));
    const ghWinners = ghResults.filter((r) => r !== undefined);
    expect(ghWinners).toHaveLength(1);
    expect(ghWinners[0]).toMatchObject({ provider: 'github', host: 'github.com' });
    const ghFound = await repos.findByIdentity(workspaceId, {
      provider: 'github',
      host: 'github.com',
      fullName: 'race/gh',
    });
    expect(ghFound?.id).toBe(ghWinners[0]!.id);
  });

  it('GitLab seed fixture is idempotent across re-runs', async () => {
    const db = pg.handle.db;
    const { repoId } = await seedGitlabFixture(db, { workspaceId, userId });
    const again = await seedGitlabFixture(db, { workspaceId, userId });
    expect(again.repoId).toBe(repoId);

    const prs = await db.select().from(t.pullRequests).where(eq(t.pullRequests.repoId, repoId));
    expect(prs.map((p) => p.number).sort()).toEqual([5, 6]);
    const ids = prs.map((p) => p.id);
    expect(await db.select().from(t.prFiles).where(inArray(t.prFiles.prId, ids))).toHaveLength(3);
    expect(await db.select().from(t.prCommits).where(inArray(t.prCommits.prId, ids))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 0020 over pre-existing dirty data (apply 0000–0019, insert rows 0020 would
// reject, then apply 0020): normalisable data applies; case-only GitLab
// duplicates and non-GitLab host-casing duplicates abort without deleting or
// modifying anything.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

interface Journal {
  entries: { idx: number; tag: string }[];
  [k: string]: unknown;
}

function migrationsBefore(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devdigest-mig-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const cut = journal.entries.findIndex((e) => e.tag.startsWith(prefix));
  if (cut < 0) throw new Error(`migration ${prefix} not found in journal`);
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

d('migration 0020 — applies over pre-existing rows', () => {
  let container: StartedPostgreSqlContainer;
  let sql: postgres.Sql;
  let oldDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('devdigest')
      .withUsername('devdigest')
      .withPassword('devdigest')
      .start();
    sql = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    oldDir = migrationsBefore('0020_');
    await migrate(drizzle(sql), { migrationsFolder: oldDir });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
    if (oldDir) rmSync(oldDir, { recursive: true, force: true });
  });

  it('aborts on GitLab case-only / non-GitLab host-casing duplicates without touching rows, then applies cleanly over dirty host/enum data', async () => {
    const [ws] = await sql`INSERT INTO workspaces (name) VALUES ('Dirty') RETURNING id`;
    const repo = (fullName: string, provider: string, host: string, createdAt: string) => sql`
      INSERT INTO repos (workspace_id, owner, name, full_name, provider, host, created_at)
      VALUES (${ws!.id}, 'g', 'p', ${fullName}, ${provider}, ${host}, ${createdAt})
      RETURNING id`;
    const pullOf = (repoId: string, number: number) => sql`
      INSERT INTO pull_requests (workspace_id, repo_id, number, title, author, branch, base, head_sha)
      VALUES (${ws!.id}, ${repoId}, ${number}, 'pr', 'octo', 'feat', 'main', 'sha') RETURNING id`;
    const [oldest] = await repo('Grp/Proj', 'gitlab', 'gitlab.com', '2026-01-01T00:00:00Z');
    const [dupe] = await repo('grp/proj', 'gitlab', 'gitlab.com', '2026-02-01T00:00:00Z');
    const [ghA] = await repo('Acme/Web', 'github', 'github.com', '2026-01-01T00:00:00Z');
    const [ghB] = await repo('acme/web', 'github', 'github.com', '2026-02-01T00:00:00Z');
    const [upper] = await repo('acme/upper', 'github', 'GitHub.com', '2026-01-01T00:00:00Z');
    const [pr] = await pullOf(ghA!.id, 1);
    const [dupePr] = await pullOf(dupe!.id, 2);
    await sql`
      INSERT INTO reviews (workspace_id, pr_id, kind, score) VALUES (${ws!.id}, ${dupePr!.id}, 'review', 70)`;
    await sql`
      INSERT INTO pr_files (pr_id, path, change_type, patch_omitted) VALUES
        (${pr!.id}, 'ok.ts', 'renamed', 'collapsed'),
        (${pr!.id}, 'bad.ts', 'copied', 'binary')`;

    // 1) GitLab case-only duplicates → 0020 aborts; the whole migration rolls back.
    await expect(migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })).rejects.toThrow(
      /migration 0020: GitLab repos differing only by case in full_name exist/,
    );
    const repoIds = (await sql`SELECT id FROM repos`).map((r) => r.id);
    expect(repoIds).toEqual(expect.arrayContaining([oldest!.id, dupe!.id, ghA!.id, ghB!.id, upper!.id]));
    expect(await sql`SELECT id FROM pull_requests WHERE id = ${dupePr!.id}`).toHaveLength(1);
    expect(await sql`SELECT id FROM reviews WHERE pr_id = ${dupePr!.id}`).toHaveLength(1);
    const [stillUpper] = await sql`SELECT host FROM repos WHERE id = ${upper!.id}`;
    expect(stillUpper!.host).toBe('GitHub.com'); // guard (1) rolled back with the abort
    const applied = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    expect(applied[0]!.n).toBe(20); // 0000–0019 only

    // 2) Operator removes the GitLab duplicate, but a non-GitLab row now differs
    //    from another ONLY by host casing → lower-casing the host would collide
    //    on the non-GitLab unique index. 0020 must abort with a clear message
    //    (checked BEFORE the host UPDATE), not a raw 23505, and touch nothing.
    await sql`DELETE FROM repos WHERE id = ${dupe!.id}`;
    const [hostDupe] = await repo('acme/upper', 'github', 'github.com', '2026-02-01T00:00:00Z');
    await expect(migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })).rejects.toThrow(
      /migration 0020: non-GitLab repos differing only by host casing exist/,
    );
    const hosts = await sql`
      SELECT id, host FROM repos WHERE id IN (${upper!.id}, ${hostDupe!.id}) ORDER BY created_at`;
    expect(hosts.map((r) => [r.id, r.host])).toEqual([
      [upper!.id, 'GitHub.com'],
      [hostDupe!.id, 'github.com'],
    ]);
    const stillApplied = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    expect(stillApplied[0]!.n).toBe(20);

    // 3) Operator removes that duplicate too → 0020 applies over the remaining dirty data.
    await sql`DELETE FROM repos WHERE id = ${hostDupe!.id}`;
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });

    const after = (await sql`SELECT id FROM repos`).map((r) => r.id);
    expect(after).toEqual(expect.arrayContaining([oldest!.id, ghA!.id, ghB!.id, upper!.id]));
    const [u] = await sql`SELECT host FROM repos WHERE id = ${upper!.id}`;
    expect(u!.host).toBe('github.com');

    const files = await sql`SELECT path, change_type, patch_omitted FROM pr_files ORDER BY path`;
    expect(files.map((f) => [f.path, f.change_type, f.patch_omitted])).toEqual([
      ['bad.ts', null, null],
      ['ok.ts', 'renamed', 'collapsed'],
    ]);
  });
});
