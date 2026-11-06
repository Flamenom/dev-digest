import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { createDb } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { dockerAvailable } from './helpers/pg.js';
import {
  APP_PASSWORD,
  BACKUP_DIR_IN_CONTAINER as DIR,
  DB_NAME,
  OWNER_USER,
  PG_UID,
  SCRIPT_IN_CONTAINER as SCRIPT,
  backupEnv,
  startDeployPg,
  type DeployPg,
  type RunResult,
} from './helpers/deploy-pg.js';

/**
 * AC-22, AC-24 – AC-27, AC-30 — `deploy/backup/devdigest-backup.sh` run INSIDE a
 * pgvector:pg16 container as the image's postgres uid (as the compose `backup`
 * service does), dumping as the read-only `devdigest_backup` role, then restored
 * the way the runbook documents it (AC-29).
 *
 * Q5 ("seed rows in every table"): `seed()` first, then a generic catalog-driven
 * filler inserts one row into every table that is still empty (NOT NULL columns
 * get a type-shaped value, FKs point at an existing row). The test then asserts
 * that NO public table is empty, except the commented allowlist below.
 */

/**
 * Tables that cannot be seeded meaningfully by the generic filler. Each entry
 * needs a comment saying why. Keep it empty unless a table truly cannot hold a
 * row without hand-written domain data.
 */
const EMPTY_TABLE_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/**
 * Generic values that a table's CHECK constraint rejects: `table.column` → SQL
 * expression. Applied whether or not the column is NOT NULL.
 */
const COLUMN_OVERRIDES: Readonly<Record<string, string>> = {
  // AES-GCM nonce: CHECK (octet_length(nonce) = 12).
  'encrypted_secrets.nonce': `'\\x000000000000000000000000'::bytea`,
  // CHECK (anchor_kind in ('multi_line', 'single_line', 'general', 'deferred')).
  'review_publication_items.anchor_kind': `'general'`,
};

/** Canary password: must appear nowhere — argv, logs, dump name, dump bytes. */
const CANARY = `CANARYbackup_${randomBytes(16).toString('hex')}`;
const NIGHTLY_RE = /^devdigest-\d{8}T\d{6}Z-nightly\.dump$/;

const docker = await dockerAvailable();

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

interface Col {
  table: string;
  column: string;
  type: string; // format_type(), e.g. "vector(1536)", "text[]", "timestamp with time zone"
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  enumLabel: string | null;
}
interface Fk {
  table: string;
  cols: string[];
  refTable: string;
  refCols: string[];
}

/** One row per still-empty public table, in FK order (several passes). */
async function fillEmptyTables(sql: postgres.Sql): Promise<Map<string, string>> {
  const cols = await sql<Col[]>`
    select c.relname as "table", a.attname as "column",
           format_type(a.atttypid, a.atttypmod) as "type",
           a.attnotnull as "notNull", a.atthasdef as "hasDefault",
           (a.attidentity <> '' or a.attgenerated <> '') as "generated",
           (select e.enumlabel from pg_enum e where e.enumtypid = a.atttypid
             order by e.enumsortorder limit 1) as "enumLabel"
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`;
  const fks = await sql<Fk[]>`
    select c.relname as "table", rc.relname as "refTable",
           array(select a.attname from unnest(k.conkey) with ordinality u(n, i)
                 join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.i) as "cols",
           array(select a.attname from unnest(k.confkey) with ordinality u(n, i)
                 join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.i) as "refCols"
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_class rc on rc.oid = k.confrelid
    join pg_namespace n on n.oid = c.relnamespace
    where k.contype = 'f' and n.nspname = 'public'`;

  const tables = [...new Set(cols.map((c) => c.table))];
  const errors = new Map<string, string>();
  const isEmpty = async (t: string) =>
    (await sql.unsafe<{ e: boolean }[]>(`select not exists (select 1 from public.${qi(t)}) as e`))[0]!.e;

  const valueFor = (c: Col): string | null => {
    if (c.enumLabel !== null) return `'${c.enumLabel.replace(/'/g, "''")}'::${c.type}`;
    const t = c.type;
    if (t.endsWith('[]')) return `'{}'::${t}`;
    const vec = /^vector\((\d+)\)$/.exec(t);
    if (vec) return `('[' || array_to_string(array_fill(0::real, array[${vec[1]}]), ',') || ']')::${t}`;
    if (t === 'uuid') return 'gen_random_uuid()';
    if (/^(text|character varying|character)/.test(t)) return `'backup-restore-seed-' || substr(md5(random()::text), 1, 8)`;
    if (/^(integer|bigint|smallint|numeric|real|double precision)/.test(t)) return '1';
    if (t === 'boolean') return 'false';
    if (t.startsWith('timestamp') || t === 'date') return 'now()';
    if (t === 'jsonb' || t === 'json') return `'{}'::${t}`;
    if (t === 'bytea') return `'\\x00'::bytea`;
    if (t === 'inet') return `'127.0.0.1'::inet`;
    return null;
  };

  for (let pass = 0; pass < 6; pass++) {
    let progress = false;
    for (const table of tables) {
      if (!(await isEmpty(table))) continue;
      const tableFks = fks.filter((f) => f.table === table && f.refTable !== table);
      const fkCol = new Map<string, { alias: string; refCol: string }>();
      const froms: string[] = [];
      let blocked = false;
      for (const [i, fk] of tableFks.entries()) {
        const mandatory = fk.cols.some((col) => cols.find((c) => c.table === table && c.column === col)?.notNull);
        if (await isEmpty(fk.refTable)) {
          if (mandatory) blocked = true;
          continue;
        }
        const alias = `f${i}`;
        froms.push(`(select * from public.${qi(fk.refTable)} limit 1) ${alias}`);
        fk.cols.forEach((col, j) => {
          if (!fkCol.has(col)) fkCol.set(col, { alias, refCol: fk.refCols[j]! });
        });
      }
      if (blocked) {
        errors.set(table, 'blocked: a NOT NULL foreign key references an empty table');
        continue;
      }
      const names: string[] = [];
      const exprs: string[] = [];
      for (const c of cols.filter((x) => x.table === table)) {
        if (c.generated) continue;
        const fk = fkCol.get(c.column);
        if (fk) {
          names.push(qi(c.column));
          exprs.push(`${fk.alias}.${qi(fk.refCol)}`);
          continue;
        }
        const override = COLUMN_OVERRIDES[`${table}.${c.column}`];
        if (override !== undefined) {
          names.push(qi(c.column));
          exprs.push(override);
          continue;
        }
        if (!c.notNull || c.hasDefault) continue;
        const v = valueFor(c);
        if (v === null) {
          blocked = true;
          errors.set(table, `no generic value for ${c.column} (${c.type})`);
          break;
        }
        names.push(qi(c.column));
        exprs.push(v);
      }
      if (blocked) continue;
      const stmt = names.length
        ? `insert into public.${qi(table)} (${names.join(', ')}) select ${exprs.join(', ')}${froms.length ? ` from ${froms.join(', ')}` : ''}`
        : `insert into public.${qi(table)} default values`;
      try {
        await sql.unsafe(stmt);
        errors.delete(table);
        progress = true;
      } catch (e) {
        errors.set(table, (e as Error).message);
      }
    }
    if (!progress) break;
  }
  return errors;
}

async function countRows(sql: postgres.Sql, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const [r] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${qi(t)}`);
    out[t] = r!.n;
  }
  const [j] = await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
  out['drizzle.__drizzle_migrations'] = j!.n;
  return out;
}

describe.skipIf(!docker)('backup service dump + documented restore (AC-22, AC-24–AC-27, AC-30)', () => {
  let pg: DeployPg;
  let owner: postgres.Sql;
  let publicTables: string[] = [];
  let fillErrors = new Map<string, string>();

  const runScript = (args: string[], extra: Record<string, string> = {}): Promise<RunResult> =>
    pg.exec(['sh', SCRIPT, ...args], { user: PG_UID, env: backupEnv(CANARY, extra) });
  const sh = (cmd: string, user = 'root') => pg.exec(['sh', '-c', cmd], { user });
  const listDumps = async () =>
    (await sh(`ls -1A ${DIR}`)).stdout.split('\n').filter((l) => l.length > 0).sort();

  beforeAll(async () => {
    pg = await startDeployPg();
    await pg.migrate();
    const g = await pg.applyGrants({ appPassword: APP_PASSWORD, backupPassword: CANARY });
    expect(g.code, g.stderr).toBe(0);
    expect(g.stdout + g.stderr).not.toContain(CANARY);

    const handle = createDb(pg.ownerUrl(), { max: 2 });
    try {
      await seed(handle.db);
    } finally {
      await handle.close();
    }
    owner = postgres(pg.ownerUrl(), { max: 2, onnotice: () => {} });
    fillErrors = await fillEmptyTables(owner);
    const rows = await owner<{ t: string }[]>`
      select table_name as t from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    publicTables = rows.map((r) => r.t);
  });

  afterAll(async () => {
    await owner?.end({ timeout: 5 }).catch(() => undefined);
    if (process.env.DEBUG_DEPLOY_PG) {
      const stream = await pg.container.logs({ tail: 80 });
      const chunks: string[] = [];
      await new Promise<void>((resolve) => {
        stream.on('data', (d: Buffer | string) => chunks.push(String(d)));
        stream.on('end', () => resolve());
        setTimeout(resolve, 3000);
      });
      console.log(chunks.join(''));
    }
    await pg?.stop();
  });

  it('seeds a row in every public table (Q5 allowlist is explicit)', async () => {
    const counts = await countRows(owner, publicTables);
    const empty = publicTables.filter((t) => counts[t] === 0 && !EMPTY_TABLE_ALLOWLIST.has(t));
    expect(empty, JSON.stringify(Object.fromEntries(fillErrors), null, 2)).toEqual([]);
    expect(counts.audit_events).toBeGreaterThan(0);
    expect(counts['drizzle.__drizzle_migrations']).toBeGreaterThan(0);
  });

  it('daemon start marks the first start and locks the backup dir to 0700', async () => {
    // Start the daemon, let it reach its sleep, then SIGTERM exactly its pid (not
    // `timeout`, which signals a process group that also holds the postmaster).
    const r = await pg.exec(
      ['sh', '-c', `sh ${SCRIPT} daemon & pid=$!; sleep 2; kill -TERM "$pid"; wait "$pid"`],
      { user: PG_UID, env: backupEnv(CANARY) },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('backup: stopped signal');
    expect(r.stderr).toMatch(/backup: next-run in \d+s/);
    expect(r.stderr).toContain('backup: started schedule 03:15 UTC');
    expect(r.stdout + r.stderr).not.toContain(CANARY);
    expect((await sh(`stat -c '%a' ${DIR}`)).stdout.trim()).toBe('700');
    expect((await sh(`test -f ${DIR}/.first-start && echo yes`)).stdout.trim()).toBe('yes');
    expect((await sh(`stat -c '%a' /tmp/.pgpass`)).stdout.trim()).toBe('600');
  });

  let dumpName = '';

  it('dumps as the backup role: TOC, modes, name, and no password in argv / logs / name / bytes', async () => {
    // Hold audit_events so pg_dump blocks mid-dump: the process list is sampled
    // deterministically while pg_dump is alive (AC-24).
    let argvSample = '';
    let pgDumpEnv = '';
    let dumpRun: Promise<RunResult> | undefined;
    await owner.begin(async (tx) => {
      await tx`lock table public.audit_events in access exclusive mode`;
      dumpRun = runScript(['dump', 'nightly']);
      for (let i = 0; i < 200 && !argvSample.includes('pg_dump'); i++) {
        await new Promise((r) => setTimeout(r, 100));
        argvSample = (
          await sh(`for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null; echo; done`)
        ).stdout;
      }
      pgDumpEnv = (
        await sh(
          `for p in /proc/[0-9]*; do if tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -Eq '^([^ ]*/)?pg_dump '; then tr '\\0' '\\n' < "$p/environ"; fi; done`,
          // /proc/<pid>/environ needs ptrace-read rights: same uid as pg_dump.
          PG_UID,
        )
      ).stdout;
    });
    const r = await dumpRun!;
    expect(r.code, r.stderr).toBe(0);
    expect(argvSample).toMatch(/(^|\/)pg_dump -Fc /m);
    expect(argvSample).not.toContain(CANARY);
    expect(pgDumpEnv).toContain('PGPASSFILE=/tmp/.pgpass');
    expect(pgDumpEnv).not.toContain(CANARY);
    expect(pgDumpEnv).not.toContain('BACKUP_DB_PASSWORD');

    const lastLine = r.stdout.trim().split('\n').pop() ?? '';
    expect(lastLine).toMatch(/^dump: /);
    dumpName = lastLine.slice('dump: '.length);
    expect(dumpName).toMatch(NIGHTLY_RE);
    expect(r.stdout + r.stderr).not.toContain(CANARY);
    expect(r.stderr).toContain(`backup: dump-ok ${dumpName}`);

    expect(await listDumps()).toEqual(['.first-start', dumpName]);
    expect((await sh(`stat -c '%a' ${DIR}/${dumpName}`)).stdout.trim()).toBe('600');
    expect((await sh(`stat -c '%a' ${DIR}`)).stdout.trim()).toBe('700');

    const bytes = Buffer.from((await sh(`base64 -w0 ${DIR}/${dumpName}`)).stdout.trim(), 'base64');
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('PGDMP');
    expect(bytes.includes(Buffer.from(CANARY))).toBe(false);

    const toc = await pg.exec(['pg_restore', '--list', `${DIR}/${dumpName}`], { user: PG_UID });
    expect(toc.code, toc.stderr).toBe(0);
    for (const t of publicTables) expect(toc.stdout, t).toContain(`TABLE DATA public ${t} `);
    expect(toc.stdout).toContain('TABLE DATA public audit_events ');
    expect(toc.stdout).toContain('TABLE DATA drizzle __drizzle_migrations ');
  });

  it('restores the documented way: counts equal, migrate applies nothing, runtime grants match grants.sql', async () => {
    expect(dumpName).not.toBe('');
    const before = await countRows(owner, publicTables);
    await owner.end({ timeout: 5 });

    // Runbook AC-29 steps 2–4, as the owner: drop + re-create, restore without
    // ownership/privileges, then `migrate` (migrations + apply-grants.mjs).
    const drop = await pg.psqlOwner('postgres', `DROP DATABASE ${DB_NAME} WITH (FORCE)`);
    expect(drop.code, drop.stderr).toBe(0);
    const create = await pg.psqlOwner('postgres', `CREATE DATABASE ${DB_NAME} OWNER ${OWNER_USER}`);
    expect(create.code, create.stderr).toBe(0);
    const restore = await pg.exec(
      [
        'pg_restore',
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '-h',
        '/var/run/postgresql',
        '-U',
        OWNER_USER,
        '-d',
        DB_NAME,
        `${DIR}/${dumpName}`,
      ],
      { user: PG_UID },
    );
    expect(restore.code, restore.stderr).toBe(0);

    owner = postgres(pg.ownerUrl(), { max: 2, onnotice: () => {} });
    const journalBefore = (await countRows(owner, []))['drizzle.__drizzle_migrations'];
    await pg.migrate();
    const g = await pg.applyGrants({ appPassword: APP_PASSWORD, backupPassword: CANARY });
    expect(g.code, g.stderr).toBe(0);

    const after = await countRows(owner, publicTables);
    expect(after).toEqual(before);
    expect(after['drizzle.__drizzle_migrations']).toBe(journalBefore);

    const grants = await owner<{ s: string; t: string; p: string }[]>`
      select table_schema as s, table_name as t, privilege_type as p
      from information_schema.role_table_grants where grantee = 'devdigest_app'`;
    const actual = grants.map((g) => `${g.s}.${g.t}:${g.p}`).sort();
    const expected = publicTables
      .flatMap((t) =>
        (t === 'audit_events' ? ['SELECT', 'INSERT'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']).map(
          (p) => `public.${t}:${p}`,
        ),
      )
      .sort();
    expect(actual).toEqual(expected);
    expect(actual.some((x) => x.startsWith('drizzle.'))).toBe(false);

    // The runtime role and the backup role both work against the restored DB.
    const app = postgres(pg.roleUrl('devdigest_app', APP_PASSWORD), { max: 1, onnotice: () => {} });
    try {
      await app`select count(*) from public.workspaces`;
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it('a failed dump leaves no partial file, keeps earlier dumps, skips rotation, and logs', async () => {
    const earlier = await listDumps();
    const sizeBefore = (await sh(`stat -c '%s' ${DIR}/${dumpName}`)).stdout.trim();
    expect((await sh(`chmod 0555 ${DIR}`)).code).toBe(0);
    try {
      const r = await runScript(['dump', 'nightly'], { BACKUP_RETAIN: '1' });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/backup: dump-failed devdigest-\d{8}T\d{6}Z-nightly\.dump \(pg_dump failed\)/);
      expect(r.stdout + r.stderr).not.toContain(CANARY);
    } finally {
      await sh(`chmod 0700 ${DIR}`);
    }
    expect(await listDumps()).toEqual(earlier);
    expect((await sh(`stat -c '%s' ${DIR}/${dumpName}`)).stdout.trim()).toBe(sizeBefore);
  });

  it('rotates each kind separately, keeping the newest N', async () => {
    await sh(`rm -f ${DIR}/devdigest-*.dump`, PG_UID);
    const fake = (name: string, hoursAgo: number) =>
      sh(`umask 077; echo x > ${DIR}/${name} && touch -d '${hoursAgo} hours ago' ${DIR}/${name}`, PG_UID);
    for (let i = 1; i <= 4; i++) await fake(`devdigest-2026010${i}T031500Z-nightly.dump`, 100 - i);
    await fake('devdigest-20260101T120000Z-pre-update-aaaaaaa.dump', 90);
    await fake('devdigest-20260102T120000Z-pre-update-bbbbbbb.dump', 80);
    // A stale temp file from a dead run (> 24 h) is cleaned; a fresh one is not touched.
    await fake('.tmp-devdigest-20260101T031500Z-nightly.dump', 30);
    await fake('.tmp-devdigest-29990101T031500Z-nightly.dump', 0);

    const r = await runScript(['dump', 'nightly'], { BACKUP_RETAIN: '3' });
    expect(r.code, r.stderr).toBe(0);
    const name = r.stdout.trim().split('\n').pop()!.slice('dump: '.length);
    expect(await listDumps()).toEqual(
      [
        '.first-start',
        '.tmp-devdigest-29990101T031500Z-nightly.dump',
        'devdigest-20260103T031500Z-nightly.dump',
        'devdigest-20260104T031500Z-nightly.dump',
        name,
        'devdigest-20260101T120000Z-pre-update-aaaaaaa.dump',
        'devdigest-20260102T120000Z-pre-update-bbbbbbb.dump',
      ].sort(),
    );
    expect(r.stderr).toContain('backup: rotated devdigest-20260101T031500Z-nightly.dump');
    expect(r.stderr).toContain('backup: stale-tmp-removed .tmp-devdigest-20260101T031500Z-nightly.dump');

    // Pre-update kind: named with the sha7, rotated on its own count only.
    const p = await runScript(['dump', 'pre-update', '0123456789abcdef0123456789abcdef01234567'], {
      BACKUP_RETAIN_PRE_UPDATE: '2',
    });
    expect(p.code, p.stderr).toBe(0);
    const pre = p.stdout.trim().split('\n').pop()!.slice('dump: '.length);
    expect(pre).toMatch(/^devdigest-\d{8}T\d{6}Z-pre-update-0123456\.dump$/);
    const after = await listDumps();
    expect(after.filter((f) => f.includes('-pre-update-')).sort()).toEqual(
      ['devdigest-20260102T120000Z-pre-update-bbbbbbb.dump', pre].sort(),
    );
    expect(after.filter((f) => f.endsWith('-nightly.dump') && !f.startsWith('.tmp-'))).toHaveLength(3);

    // Bad input never produces a dump.
    const bad = await runScript(['dump', 'pre-update', 'not-a-sha']);
    expect(bad.code).toBe(1);
  });

  it('health: unhealthy when the newest nightly dump and the first start are older than 26 h', async () => {
    await sh(`rm -f ${DIR}/devdigest-*.dump ${DIR}/.tmp-*`, PG_UID);
    await sh(
      `touch -d '27 hours ago' ${DIR}/.first-start && echo x > ${DIR}/devdigest-20260101T031500Z-nightly.dump && touch -d '27 hours ago' ${DIR}/devdigest-20260101T031500Z-nightly.dump`,
      PG_UID,
    );
    expect((await runScript(['health'])).code).toBe(1);
    // Only a fresh PRE-UPDATE dump does not count as a nightly success.
    await sh(`echo x > ${DIR}/devdigest-20260102T031500Z-pre-update-abcdef1.dump`, PG_UID);
    expect((await runScript(['health'])).code).toBe(1);
    // Inside the first-start grace period with no dump yet → healthy.
    await sh(`touch ${DIR}/.first-start`, PG_UID);
    expect((await runScript(['health'])).code).toBe(0);
    // A fresh nightly dump → healthy even after the grace period.
    await sh(`touch -d '27 hours ago' ${DIR}/.first-start && touch ${DIR}/devdigest-20260101T031500Z-nightly.dump`, PG_UID);
    expect((await runScript(['health'])).code).toBe(0);
  });
});
