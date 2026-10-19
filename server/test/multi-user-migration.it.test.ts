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
 * Migration 0021 (multi-user server mode) must be additive for existing data
 * (AC-48): apply 0000–0020, insert a representative pre-0021 graph with raw SQL
 * (the current Drizzle schema already names the 0021 columns), apply 0021, then
 * assert every pre-existing row/value is unchanged EXCEPT `workspace_members.role`
 * `owner` → `admin`, and every new actor column is null. Also checks the new
 * DB-level guards: role/status CHECKs, the append-only audit trigger, the
 * encrypted-secret (workspace, key) uniqueness and case-insensitive email
 * uniqueness for Google-identified users.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const TARGET_TAG_PREFIX = '0021_';

interface Journal {
  entries: { idx: number; tag: string }[];
  [k: string]: unknown;
}

/** Copy of the migrations folder whose journal stops just before 0021. */
function migrationsBefore0021(): string {
  return migrationsBefore(TARGET_TAG_PREFIX);
}

/** Copy of the migrations folder whose journal stops just before the migration tagged `prefix`. */
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

/** Tables whose pre-existing rows must survive 0021 unchanged (ordered by a stable key). */
const SNAPSHOT_TABLES: Record<string, string> = {
  users: 'id',
  workspaces: 'id',
  workspace_members: 'workspace_id, user_id',
  repos: 'id',
  pull_requests: 'id',
  reviews: 'id',
  findings: 'id',
  agents: 'id',
  agent_versions: 'agent_id, version',
  agent_runs: 'id',
  eval_cases: 'id',
  skills: 'id',
  skill_versions: 'skill_id, version',
};

/** New nullable actor columns added by 0021 on existing tables. */
const NEW_NULL_COLUMNS: Record<string, string[]> = {
  users: ['google_sub', 'avatar_url', 'last_sign_in_at'],
  workspace_members: ['status_changed_at', 'status_changed_by', 'joined_at'],
  agent_runs: ['initiated_by'],
  findings: ['acted_by'],
  eval_cases: ['created_by'],
  agents: ['updated_by'],
  agent_versions: ['author_id'],
  skills: ['created_by', 'updated_by'],
  skill_versions: ['author_id'],
};

type Row = Record<string, unknown>;

d('migration 0021 — multi-user server mode', () => {
  let container: StartedPostgreSqlContainer;
  let sql: postgres.Sql;
  let oldDir: string;
  let workspaceId: string;
  let systemUserId: string;
  let memberUserId: string;
  const before: Record<string, Row[]> = {};

  async function rows(table: string): Promise<Row[]> {
    return [...(await sql.unsafe(`SELECT * FROM "${table}" ORDER BY ${SNAPSHOT_TABLES[table]}`))];
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('devdigest')
      .withUsername('devdigest')
      .withPassword('devdigest')
      .start();
    sql = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    oldDir = migrationsBefore0021();
    await migrate(drizzle(sql), { migrationsFolder: oldDir });

    // ---- representative pre-0021 graph ----
    const [ws] = await sql`INSERT INTO workspaces (name) VALUES ('default') RETURNING id`;
    workspaceId = ws!.id as string;
    const [sys] = await sql`INSERT INTO users (email, name) VALUES ('you@local', 'You') RETURNING id`;
    systemUserId = sys!.id as string;
    const [mem] = await sql`INSERT INTO users (email, name) VALUES ('m@local', 'Mem') RETURNING id`;
    memberUserId = mem!.id as string;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role)
              VALUES (${workspaceId}, ${systemUserId}, 'owner'), (${workspaceId}, ${memberUserId}, 'member')`;

    const [repo] = await sql`
      INSERT INTO repos (workspace_id, owner, name, full_name, created_by)
      VALUES (${workspaceId}, 'mu', 'legacy-api', 'mu/legacy-api', ${systemUserId}) RETURNING id`;
    const [pr] = await sql`
      INSERT INTO pull_requests (workspace_id, repo_id, number, title, author, branch, base, head_sha)
      VALUES (${workspaceId}, ${repo!.id}, 7, 'PR 7', 'octo', 'feat/7', 'main', 'sha-7') RETURNING id`;
    const [agent] = await sql`
      INSERT INTO agents (workspace_id, name, provider, model, system_prompt, created_by)
      VALUES (${workspaceId}, 'Legacy reviewer', 'openrouter', 'm', 'prompt', ${systemUserId}) RETURNING id`;
    await sql`INSERT INTO agent_versions (agent_id, version, config_json)
              VALUES (${agent!.id}, 1, ${JSON.stringify({ model: 'm' })}::jsonb)`;
    const [run] = await sql`
      INSERT INTO agent_runs (workspace_id, agent_id, pr_id, status, score)
      VALUES (${workspaceId}, ${agent!.id}, ${pr!.id}, 'done', 80) RETURNING id`;
    const [rv] = await sql`
      INSERT INTO reviews (workspace_id, pr_id, kind, score, run_id)
      VALUES (${workspaceId}, ${pr!.id}, 'review', 80, ${run!.id}) RETURNING id`;
    const [finding] = await sql`
      INSERT INTO findings (review_id, file, start_line, end_line, severity, category, title, rationale, confidence, accepted_at)
      VALUES (${rv!.id}, 'src/a.ts', 1, 2, 'major', 'bug', 'legacy finding', 'because', 0.9, now())
      RETURNING id`;
    await sql`
      INSERT INTO eval_cases (workspace_id, owner_kind, owner_id, name, source_finding_id)
      VALUES (${workspaceId}, 'agent', ${agent!.id}, 'legacy case', ${finding!.id})`;
    const [skill] = await sql`
      INSERT INTO skills (workspace_id, name, description, type, source, body, version)
      VALUES (${workspaceId}, 'Legacy skill', 'd', 'rubric', 'manual', 'body v2', 2) RETURNING id`;
    await sql`INSERT INTO skill_versions (skill_id, version, body, note)
              VALUES (${skill!.id}, 1, 'body v1', null), (${skill!.id}, 2, 'body v2', 'edit')`;

    for (const table of Object.keys(SNAPSHOT_TABLES)) before[table] = await rows(table);

    // Apply the real folder: 0021 (+ follow-up 0022 indexes) are pending.
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
    if (oldDir) rmSync(oldDir, { recursive: true, force: true });
  });

  it('keeps every pre-existing row and value, except owner → admin (AC-48)', async () => {
    for (const [table, prev] of Object.entries(before)) {
      expect(prev.length, `${table} seeded`).toBeGreaterThan(0);
      const after = await rows(table);
      expect(after, `${table} row count`).toHaveLength(prev.length);
      // Project the post-0021 rows onto the pre-0021 columns.
      const projected = after.map((r) =>
        Object.fromEntries(Object.keys(prev[0]!).map((k) => [k, r[k]])),
      );
      if (table === 'workspace_members') {
        const expected = prev.map((r) => ({ ...r, role: r.role === 'owner' ? 'admin' : r.role }));
        expect(projected).toEqual(expected);
      } else {
        expect(projected, table).toEqual(prev);
      }
    }

    const roles = await sql`SELECT user_id, role, status FROM workspace_members`;
    const byUser = new Map(roles.map((r) => [r.user_id as string, r]));
    expect(byUser.get(systemUserId)).toMatchObject({ role: 'admin', status: 'active' });
    expect(byUser.get(memberUserId)).toMatchObject({ role: 'member', status: 'active' });
  });

  it('adds every new actor column as nullable and leaves it null on existing rows', async () => {
    for (const [table, cols] of Object.entries(NEW_NULL_COLUMNS)) {
      const meta = await sql`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = ${table} AND column_name IN ${sql(cols)}`;
      expect(meta, `${table} columns`).toHaveLength(cols.length);
      for (const c of meta) expect(c.is_nullable, `${table}.${c.column_name}`).toBe('YES');

      const nonNull = await sql.unsafe(
        `SELECT count(*)::int AS n FROM "${table}" WHERE ${cols.map((c) => `"${c}" IS NOT NULL`).join(' OR ')}`,
      );
      expect(nonNull[0]!.n, `${table} new columns null`).toBe(0);
    }
  });

  it('rejects role owner and an unknown status via CHECK constraints', async () => {
    const [u] = await sql`INSERT INTO users (email, name) VALUES ('ck@local', 'Ck') RETURNING id`;
    await expect(
      sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${u!.id}, 'owner')`,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'workspace_members_role_ck' });
    await expect(
      sql`INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (${workspaceId}, ${u!.id}, 'member', 'x')`,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'workspace_members_status_ck' });
    await expect(
      sql`UPDATE workspace_members SET role = 'owner' WHERE user_id = ${memberUserId}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('makes audit_events append-only: UPDATE and DELETE raise', async () => {
    const [ev] = await sql`
      INSERT INTO audit_events (workspace_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (${workspaceId}, ${systemUserId}, 'member.role_change', 'user', ${memberUserId}, ${JSON.stringify({ role: 'admin' })}::jsonb)
      RETURNING id, created_at`;
    expect(ev!.created_at).toBeTruthy(); // default now() applied

    await expect(
      sql`UPDATE audit_events SET action = 'tampered' WHERE id = ${ev!.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_events WHERE id = ${ev!.id}`).rejects.toThrow(
      /append-only/,
    );
    const [kept] = await sql`SELECT action FROM audit_events WHERE id = ${ev!.id}`;
    expect(kept!.action).toBe('member.role_change');
  });

  it('enforces one encrypted secret per (workspace, key_name)', async () => {
    const insert = (key: string) => sql`
      INSERT INTO encrypted_secrets (workspace_id, key_name, ciphertext, nonce, key_id)
      VALUES (${workspaceId}, ${key}, ${Buffer.from('ct')}, ${Buffer.alloc(12, 1)}, 'kid')`;
    await insert('GITHUB_TOKEN');
    await insert('OPENAI_API_KEY');
    await expect(insert('GITHUB_TOKEN')).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'encrypted_secrets_ws_key_uq',
    });

    const [row] = await sql`SELECT ciphertext, nonce FROM encrypted_secrets WHERE key_name = 'GITHUB_TOKEN'`;
    expect(Buffer.isBuffer(row!.ciphertext)).toBe(true);
    expect((row!.nonce as Buffer).length).toBe(12);
  });

  it('enforces case-insensitive email uniqueness only for Google-identified users', async () => {
    await sql`INSERT INTO users (email, name, google_sub) VALUES ('Ann@Onlytraf.com', 'Ann', 'sub-1')`;
    await expect(
      sql`INSERT INTO users (email, name, google_sub) VALUES ('ann@onlytraf.com', 'Ann 2', 'sub-2')`,
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'users_google_lower_email_uq' });
    await expect(
      sql`INSERT INTO users (email, name, google_sub) VALUES ('other@onlytraf.com', 'O', 'sub-1')`,
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'users_google_sub_uq' });
    // Users without a Google identity (e.g. the local system user) are not constrained.
    await sql`INSERT INTO users (email, name) VALUES ('ANN@onlytraf.com', 'Legacy')`;
    await sql`INSERT INTO users (email, name) VALUES ('ann@onlytraf.com', 'Legacy 2')`;
  });

  it('indexes the FK and expiry columns introduced by 0021 (migration 0022)', async () => {
    const expected: [string, string, string][] = [
      ['sessions', 'sessions_workspace_idx', 'workspace_id'],
      ['sessions', 'sessions_expires_at_idx', 'expires_at'],
      ['oauth_flows', 'oauth_flows_expires_at_idx', 'expires_at'],
      ['api_tokens', 'api_tokens_workspace_idx', 'workspace_id'],
      ['encrypted_secrets', 'encrypted_secrets_updated_by_idx', 'updated_by'],
      ['workspace_members', 'workspace_members_status_changed_by_idx', 'status_changed_by'],
    ];
    const found = await sql`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ${sql(expected.map(([, name]) => name))}`;
    const byName = new Map(found.map((r) => [r.indexname as string, r]));
    for (const [table, name, column] of expected) {
      const idx = byName.get(name);
      expect(idx, name).toBeDefined();
      expect(idx!.tablename, name).toBe(table);
      expect(idx!.indexdef, name).toContain(`btree (${column})`);
    }
  });
});

/**
 * Migration 0023 (postgresql-table-design hardening of the identity tables):
 * apply 0000–0022, insert legacy audit rows whose `ip` text is valid or junk,
 * apply 0023, and assert the inet conversion kept valid IPs and nulled junk
 * without the append-only trigger blocking the column rewrite. Also checks the
 * new metadata-object CHECK, TRUNCATE trigger and full api_tokens user index.
 */
d('migration 0023 — inet ip, metadata CHECK, TRUNCATE guard, api_tokens user index', () => {
  let container: StartedPostgreSqlContainer;
  let sql: postgres.Sql;
  let oldDir: string;
  let workspaceId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('devdigest')
      .withUsername('devdigest')
      .withPassword('devdigest')
      .start();
    sql = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    oldDir = migrationsBefore('0023_');
    await migrate(drizzle(sql), { migrationsFolder: oldDir });

    const [ws] = await sql`INSERT INTO workspaces (name) VALUES ('mig-0023') RETURNING id`;
    workspaceId = ws!.id as string;
    const legacy: [string, string | null][] = [
      ['legacy.v4', '10.0.0.7'],
      ['legacy.v6', '2001:db8::1'],
      ['legacy.junk', 'unknown'],
      ['legacy.hexish', 'dead:beef:zz'],
      ['legacy.bad_octet', '999.1.1.1'],
      ['legacy.null', null],
    ];
    for (const [action, ip] of legacy) {
      await sql`INSERT INTO audit_events (workspace_id, action, target_type, ip)
                VALUES (${workspaceId}, ${action}, 'session', ${ip})`;
    }

    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
    if (oldDir) rmSync(oldDir, { recursive: true, force: true });
  });

  it('converts audit_events.ip to inet, keeping valid IPs and nulling junk', async () => {
    const [col] = await sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'audit_events' AND column_name = 'ip'`;
    expect(col!.data_type).toBe('inet');

    const got = await sql`SELECT action, host(ip) AS ip FROM audit_events WHERE action LIKE 'legacy.%'`;
    const byAction = Object.fromEntries(got.map((r) => [r.action as string, r.ip as string | null]));
    expect(byAction).toEqual({
      'legacy.v4': '10.0.0.7',
      'legacy.v6': '2001:db8::1',
      'legacy.junk': null,
      'legacy.hexish': null,
      'legacy.bad_octet': null,
      'legacy.null': null,
    });
    // The throwaway safe-cast helper does not outlive the migration.
    const fns = await sql`SELECT 1 FROM pg_proc WHERE proname = 'audit_events_try_inet_0023'`;
    expect(fns).toHaveLength(0);
  });

  it('rejects an invalid inet literal at the database', async () => {
    await expect(
      sql`INSERT INTO audit_events (workspace_id, action, target_type, ip) VALUES (${workspaceId}, 'x', 'y', 'nope')`,
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it('rejects non-object metadata (audit_events_metadata_object_ck)', async () => {
    await expect(
      sql`INSERT INTO audit_events (workspace_id, action, target_type, metadata)
          VALUES (${workspaceId}, 'x', 'y', '[1,2]'::jsonb)`,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'audit_events_metadata_object_ck' });
  });

  it('refuses TRUNCATE of audit_events, directly or via CASCADE, and keeps UPDATE/DELETE refused', async () => {
    await expect(sql`TRUNCATE audit_events`).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE workspaces CASCADE`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE audit_events SET action = 't'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_events`).rejects.toThrow(/append-only/);
    const [n] = await sql`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'legacy.%'`;
    expect(n!.n).toBe(6);
  });

  it('adds a full btree api_tokens_user_idx and keeps the partial active index', async () => {
    const idx = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'api_tokens' AND indexname IN ('api_tokens_user_idx', 'api_tokens_user_active_idx')`;
    const byName = new Map(idx.map((r) => [r.indexname as string, r.indexdef as string]));
    expect(byName.get('api_tokens_user_idx')).toMatch(/btree \(user_id\)$/);
    expect(byName.get('api_tokens_user_active_idx')).toMatch(/WHERE \(revoked_at IS NULL\)/);
  });
});
