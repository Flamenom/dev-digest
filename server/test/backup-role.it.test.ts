import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { dockerAvailable } from './helpers/pg.js';
import { APP_PASSWORD, OWNER_PASSWORD, startDeployPg, type DeployPg } from './helpers/deploy-pg.js';

/**
 * AC-23 — the dedicated read-only backup role (`devdigest_backup`), created and
 * re-keyed only by `deploy/db-grants/apply-grants.mjs` → `backup-role.sql`.
 * Runs on a DEDICATED cluster (roles are cluster-wide), see helpers/deploy-pg.ts.
 */

const BACKUP_PW_1 = 'backupTESTpassword_A_0123456789abcdefABCD';
const BACKUP_PW_2 = 'backupTESTpassword_B_0123456789abcdefABCD';

const docker = await dockerAvailable();

describe.skipIf(!docker)('backup role (AC-23)', () => {
  let pg: DeployPg;
  let owner: postgres.Sql;
  let publicTables: string[] = [];

  beforeAll(async () => {
    pg = await startDeployPg();
    await pg.migrate();
    const r = await pg.applyGrants({ appPassword: APP_PASSWORD, backupPassword: BACKUP_PW_1 });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ runtime-role grants applied (devdigest_app)');
    expect(r.stdout).toContain('✓ backup-role grants applied (devdigest_backup)');
    owner = postgres(pg.ownerUrl(), { max: 2, onnotice: () => {} });
    const rows = await owner<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    publicTables = rows.map((x) => x.table_name);
  });

  afterAll(async () => {
    await owner?.end({ timeout: 5 });
    await pg?.stop();
  });

  /** One fresh connection as the backup role; always closed. */
  async function asBackup<T>(password: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(pg.roleUrl('devdigest_backup', password), { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it('has exactly the read-only attribute set, membership and settings', async () => {
    const [role] = await owner<
      { rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
    >`select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
      from pg_roles where rolname = 'devdigest_backup'`;
    expect(role).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    const memberships = await owner<{ r: string }[]>`
      select roleid::regrole::text as r from pg_auth_members where member = 'devdigest_backup'::regrole`;
    expect(memberships.map((m) => m.r)).toEqual(['pg_read_all_data']);
    const [cfg] = await owner<{ setconfig: string[] | null }[]>`
      select setconfig from pg_db_role_setting where setrole = 'devdigest_backup'::regrole and setdatabase = 0`;
    expect(cfg?.setconfig).toContain('default_transaction_read_only=on');
  });

  it('can SELECT every public table, the migrations journal and every sequence', async () => {
    expect(publicTables.length).toBeGreaterThan(10);
    expect(publicTables).toContain('audit_events');
    const seqs = await owner<{ s: string }[]>`
      select quote_ident(sequence_schema) || '.' || quote_ident(sequence_name) as s
      from information_schema.sequences where sequence_schema in ('public', 'drizzle')`;
    await asBackup(BACKUP_PW_1, async (sql) => {
      for (const t of publicTables) {
        await sql.unsafe(`select count(*) from public.${JSON.stringify(t)}`);
      }
      const [j] = await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(j!.n).toBeGreaterThan(0);
      for (const { s } of seqs) await sql.unsafe(`select last_value from ${s}`);
      const [ro] = await sql<{ v: string }[]>`select current_setting('default_transaction_read_only') as v`;
      expect(ro!.v).toBe('on');
    });
  });

  it('every write and DDL statement fails, on a representative table and on audit_events', async () => {
    const statements = (table: string) => [
      `insert into public.${table} default values`,
      `update public.${table} set id = id`,
      `delete from public.${table}`,
      `truncate public.${table}`,
      `create table public.backup_role_probe (x int)`,
      `create temp table backup_role_probe_tmp (x int)`,
      `create schema backup_role_probe_schema`,
      `alter table public.${table} add column backup_probe int`,
      `drop table public.${table}`,
    ];
    for (const table of ['workspaces', 'audit_events']) {
      for (const stmt of statements(table)) {
        await asBackup(BACKUP_PW_1, async (sql) => {
          await expect(sql.unsafe(stmt), stmt).rejects.toThrow();
        });
        // Read-only default turned off in-session: privileges are still the barrier.
        await asBackup(BACKUP_PW_1, async (sql) => {
          await sql.unsafe('set default_transaction_read_only = off');
          await expect(sql.unsafe(stmt), `[rw] ${stmt}`).rejects.toThrow();
        });
      }
    }
    // Writes into the migrations journal fail too.
    await asBackup(BACKUP_PW_1, async (sql) => {
      await sql.unsafe('set default_transaction_read_only = off');
      await expect(
        sql.unsafe(`insert into drizzle.__drizzle_migrations (hash, created_at) values ('x', 0)`),
      ).rejects.toThrow();
    });
    // Sequences are readable, never advanceable.
    await asBackup(BACKUP_PW_1, async (sql) => {
      await sql.unsafe('set default_transaction_read_only = off');
      await expect(sql.unsafe(`select nextval('drizzle.__drizzle_migrations_id_seq')`)).rejects.toThrow();
    });
    // Nothing above changed the schema.
    const [probe] = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class where relname like 'backup_role_probe%'`;
    expect(probe!.n).toBe(0);
  });

  it('apply-grants.mjs rejects a placeholder, a 31-char and a duplicate BACKUP_DB_PASSWORD, naming the setting only', async () => {
    const bad = [
      'replace-me-with-openssl-rand-hex-24-output',
      'a'.repeat(31),
      APP_PASSWORD,
      OWNER_PASSWORD,
    ];
    for (const value of bad) {
      const r = await pg.applyGrants({ appPassword: APP_PASSWORD, backupPassword: value });
      expect(r.code, value.slice(0, 4)).not.toBe(0);
      expect(r.stderr).toContain('BACKUP_DB_PASSWORD');
      expect(r.stderr).not.toContain(value);
      expect(r.stdout).not.toContain(value);
    }
    const missing = await pg.applyGrants({ appPassword: APP_PASSWORD });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('BACKUP_DB_PASSWORD is missing');
    // The role still works with its current password after the refusals.
    await asBackup(BACKUP_PW_1, (sql) => sql`select 1`);
  });

  it('backup-role.sql itself refuses a bad GUC value without echoing it', async () => {
    const value = 'short';
    const fs = await import('node:fs/promises');
    const sqlText = await fs.readFile(new URL('../../deploy/db-grants/backup-role.sql', import.meta.url), 'utf8');
    const sql = postgres(pg.ownerUrl(), { max: 1, onnotice: () => {} });
    try {
      await sql`select set_config('devdigest.backup_password', ${value}, false)`;
      const err = await sql.unsafe(sqlText).simple().then(
        () => undefined,
        (e: unknown) => e as { message: string },
      );
      expect(err?.message).toContain('BACKUP_DB_PASSWORD must be >= 32 chars');
      expect(err?.message).not.toContain(value);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('re-running apply-grants.mjs with a new password re-keys the role', async () => {
    const r = await pg.applyGrants({ appPassword: APP_PASSWORD, backupPassword: BACKUP_PW_2 });
    expect(r.code, r.stderr).toBe(0);
    await expect(asBackup(BACKUP_PW_1, (sql) => sql`select 1`)).rejects.toThrow(/password authentication failed/);
    await asBackup(BACKUP_PW_2, async (sql) => {
      const [x] = await sql<{ u: string }[]>`select current_user as u`;
      expect(x!.u).toBe('devdigest_backup');
    });
    // Idempotent: the attribute set and membership are unchanged after a re-run.
    const memberships = await owner<{ r: string }[]>`
      select roleid::regrole::text as r from pg_auth_members where member = 'devdigest_backup'::regrole`;
    expect(memberships.map((m) => m.r)).toEqual(['pg_read_all_data']);
  });

  it('fails closed when the role gained another membership', async () => {
    await owner`grant pg_write_all_data to devdigest_backup`;
    try {
      const r = await pg.applyGrants({ appPassword: APP_PASSWORD, backupPassword: BACKUP_PW_2 });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('devdigest_backup must not be a member of any role other than pg_read_all_data');
    } finally {
      await owner`revoke pg_write_all_data from devdigest_backup`;
    }
    const r = await pg.applyGrants({ appPassword: APP_PASSWORD, backupPassword: BACKUP_PW_2 });
    expect(r.code, r.stderr).toBe(0);
  });
});
