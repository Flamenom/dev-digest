import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerAvailable } from './helpers/pg.js';

/**
 * Migration 0019 (GitLab support) must be purely additive for existing data:
 * apply 0000–0018, seed pre-0019 rows with raw SQL (the current Drizzle schema
 * already names the 0019 columns, so `seed()` cannot run against the old shape),
 * then apply 0019 and assert ids / full_name / clone_path are untouched and the
 * provider/host backfill is github / github.com (AC-46). Also checks the new
 * unique index (workspace, provider, host, full_name) at DB level (AC-15/AC-16).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const TARGET_TAG_PREFIX = '0019_';

interface Journal {
  entries: { idx: number; tag: string }[];
  [k: string]: unknown;
}

/** Copy of the migrations folder whose journal stops just before 0019. */
function migrationsBefore0019(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devdigest-mig-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const cut = journal.entries.findIndex((e) => e.tag.startsWith(TARGET_TAG_PREFIX));
  if (cut < 0) throw new Error('migration 0019 not found in journal');
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

d('migration 0019 — repo host columns', () => {
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
    oldDir = migrationsBefore0019();
    await migrate(drizzle(sql), { migrationsFolder: oldDir });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
    if (oldDir) rmSync(oldDir, { recursive: true, force: true });
  });

  async function snapshot() {
    const repos = await sql`SELECT id, full_name, clone_path FROM repos ORDER BY id`;
    const prs = await sql`SELECT id, repo_id, number, head_sha FROM pull_requests ORDER BY id`;
    const files = await sql`SELECT id, pr_id, path, patch FROM pr_files ORDER BY id`;
    const reviews = await sql`SELECT id, pr_id, score FROM reviews ORDER BY id`;
    const findings = await sql`SELECT id, review_id, title FROM findings ORDER BY id`;
    return {
      repos: [...repos],
      prs: [...prs],
      files: [...files],
      reviews: [...reviews],
      findings: [...findings],
    };
  }

  it('applies 0019 without touching existing rows and backfills github / github.com', async () => {
    // The pre-0019 DB has no provider column yet.
    const before0019Cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'repos' AND column_name = 'provider'`;
    expect(before0019Cols).toHaveLength(0);

    // Seed a realistic pre-migration graph: 2 repos, PRs, files, reviews, findings.
    const [ws] = await sql`INSERT INTO workspaces (name) VALUES ('Default') RETURNING id`;
    const repoIds: string[] = [];
    for (const [i, fullName] of ['acme/payments-api', 'acme/web'].entries()) {
      const [owner, name] = fullName.split('/');
      const [r] = await sql`
        INSERT INTO repos (workspace_id, owner, name, full_name, clone_path)
        VALUES (${ws!.id}, ${owner!}, ${name!}, ${fullName}, ${`/clones/${fullName}`})
        RETURNING id`;
      repoIds.push(r!.id as string);
      for (const number of [i * 10 + 1, i * 10 + 2]) {
        const [pr] = await sql`
          INSERT INTO pull_requests (workspace_id, repo_id, number, title, author, branch, base, head_sha)
          VALUES (${ws!.id}, ${r!.id}, ${number}, ${`PR ${number}`}, 'octo', ${`feat/${number}`}, 'main', ${`sha-${number}`})
          RETURNING id`;
        await sql`
          INSERT INTO pr_files (pr_id, path, additions, deletions, patch)
          VALUES (${pr!.id}, 'src/a.ts', 3, 1, '@@ -1 +1 @@')`;
        const [rv] = await sql`
          INSERT INTO reviews (workspace_id, pr_id, kind, score)
          VALUES (${ws!.id}, ${pr!.id}, 'review', 61)
          RETURNING id`;
        await sql`
          INSERT INTO findings (review_id, file, start_line, end_line, severity, category, title, rationale, confidence)
          VALUES (${rv!.id}, 'src/a.ts', 1, 1, 'major', 'bug', ${`finding ${number}`}, 'because', 0.9)`;
      }
    }

    const before = await snapshot();
    expect(before.repos).toHaveLength(2);
    expect(before.prs).toHaveLength(4);
    expect(before.findings).toHaveLength(4);

    // Apply the real folder: only 0019 is pending.
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });

    const after = await snapshot();
    expect(after).toEqual(before);

    const repos = await sql`
      SELECT provider, host, last_synced_at, last_attempt_at, last_sync_error FROM repos`;
    expect(repos).toHaveLength(2);
    for (const r of repos) {
      expect(r.provider).toBe('github');
      expect(r.host).toBe('github.com');
      expect(r.last_synced_at).toBeNull();
      expect(r.last_attempt_at).toBeNull();
      expect(r.last_sync_error).toBeNull();
    }

    const prs = await sql`SELECT is_draft, stats_known, detail_head_sha FROM pull_requests`;
    for (const p of prs) {
      expect([p.is_draft, p.stats_known, p.detail_head_sha]).toEqual([null, null, null]);
    }
    const files = await sql`SELECT previous_path, change_type, patch_omitted FROM pr_files`;
    for (const f of files) {
      expect([f.previous_path, f.change_type, f.patch_omitted]).toEqual([null, null, null]);
    }

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'repos'`;
    const names = idx.map((i) => i.indexname);
    expect(names).toContain('repos_ws_provider_host_fullname_uq');
    expect(names).not.toContain('repos_ws_fullname_uq');
  });

  it('allows the same full_name on two hosts but rejects a duplicate on the same host', async () => {
    const [ws] = await sql`INSERT INTO workspaces (name) VALUES ('Uniq') RETURNING id`;
    const insert = (provider: string, host: string) => sql`
      INSERT INTO repos (workspace_id, owner, name, full_name, provider, host)
      VALUES (${ws!.id}, 'acme', 'web', 'acme/web', ${provider}, ${host})`;

    await insert('github', 'github.com');
    await insert('gitlab', 'gitlab.com');
    await expect(insert('github', 'github.com')).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'repos_ws_provider_host_fullname_uq',
    });
  });

  it('rejects an unknown provider via the CHECK constraint', async () => {
    const [ws] = await sql`INSERT INTO workspaces (name) VALUES ('Check') RETURNING id`;
    await expect(
      sql`INSERT INTO repos (workspace_id, owner, name, full_name, provider, host)
          VALUES (${ws!.id}, 'acme', 'web', 'acme/web', 'bitbucket', 'bitbucket.org')`,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'repos_provider_ck' });
  });
});
