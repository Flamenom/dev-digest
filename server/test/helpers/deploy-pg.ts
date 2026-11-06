import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';
import { PG_IMAGE } from '../global-setup.js';

/**
 * A DEDICATED Postgres cluster that mirrors the deploy/ database path:
 * migrations as the owner → `deploy/db-grants/apply-grants.mjs` (grants.sql +
 * backup-role.sql), with `deploy/backup/devdigest-backup.sh` copied into the
 * container at the path the `backup` compose service mounts it.
 *
 * Dedicated (not the shared broker cluster of test/global-setup.ts) because the
 * `devdigest_app` / `devdigest_backup` roles are CLUSTER-wide: creating, re-keying
 * and dropping them must never leak into other test files' databases.
 *
 * Loopback TCP auth is switched from the image's `trust` to `scram-sha-256`, so a
 * script connecting to 127.0.0.1 really proves its password (passfile) works. The
 * unix socket stays `trust` for owner-side test plumbing (`pg_restore`, `psql`).
 */

export const OWNER_USER = 'devdigest';
export const DB_NAME = 'devdigest';
/** Test-only credentials — strong-shaped so apply-grants.mjs accepts them. */
export const OWNER_PASSWORD = 'ownerTESTpassword_0123456789abcdefABCDEF';
export const APP_PASSWORD = 'appTESTpassword_0123456789abcdefABCDEF00';

export const SCRIPT_IN_CONTAINER = '/opt/devdigest/backup/devdigest-backup.sh';
export const BACKUP_DIR_IN_CONTAINER = '/backups';
/** The image's postgres uid/gid (compose: `user: "999:999"`). */
export const PG_UID = '999';

const APPLY_GRANTS = fileURLToPath(new URL('../../../deploy/db-grants/apply-grants.mjs', import.meta.url));
const BACKUP_SCRIPT = fileURLToPath(new URL('../../../deploy/backup/devdigest-backup.sh', import.meta.url));
const SERVER_PKG = fileURLToPath(new URL('../../package.json', import.meta.url));

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DeployPg {
  container: StartedPostgreSqlContainer;
  /** Owner URL of `db` (default `devdigest`) through the mapped port. */
  ownerUrl: (db?: string) => string;
  /** URL for an arbitrary role/password on `devdigest`. */
  roleUrl: (user: string, password: string) => string;
  /** Run the server migrations as the owner (idempotent). */
  migrate: () => Promise<void>;
  /** `node deploy/db-grants/apply-grants.mjs` with the given passwords (no throw). */
  applyGrants: (env: { appPassword?: string; backupPassword?: string }) => Promise<RunResult>;
  /** Exec inside the container (default user root). */
  exec: (cmd: string[], opts?: { user?: string; env?: Record<string, string> }) => Promise<RunResult>;
  /** Owner-side SQL over the in-container unix socket (`psql -v ON_ERROR_STOP=1`). */
  psqlOwner: (db: string, sqlText: string) => Promise<RunResult>;
  stop: () => Promise<void>;
}

export async function startDeployPg(): Promise<DeployPg> {
  const container = await new PostgreSqlContainer(PG_IMAGE)
    .withDatabase(DB_NAME)
    .withUsername(OWNER_USER)
    .withPassword(OWNER_PASSWORD)
    .withCopyFilesToContainer([{ source: BACKUP_SCRIPT, target: SCRIPT_IN_CONTAINER, mode: 0o755 }])
    .start();

  const exec: DeployPg['exec'] = async (cmd, opts) => {
    const r = await container.exec(cmd, {
      ...(opts?.user ? { user: opts.user } : {}),
      ...(opts?.env ? { env: opts.env } : {}),
    });
    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  };

  const base = new URL(container.getConnectionUri());
  const ownerUrl = (db = DB_NAME) => {
    const u = new URL(base.toString());
    u.pathname = `/${db}`;
    return u.toString();
  };
  const roleUrl = (user: string, password: string) => {
    const u = new URL(ownerUrl());
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(password);
    return u.toString();
  };

  // Loopback TCP → password auth (the image's initdb default is `trust`).
  const hba = await exec([
    'sh',
    '-c',
    `sed -i -E '/^host/ s/trust[[:space:]]*$/scram-sha-256/' "$PGDATA/pg_hba.conf"`,
  ]);
  if (hba.code !== 0) throw new Error(`pg_hba rewrite failed: ${hba.stderr}`);
  const admin = postgres(ownerUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin`select pg_reload_conf()`;
  } finally {
    await admin.end({ timeout: 5 });
  }

  // /backups as the compose bind mount would look before the daemon's first start.
  const mk = await exec([
    'sh',
    '-c',
    `mkdir -p ${BACKUP_DIR_IN_CONTAINER} && chown ${PG_UID}:${PG_UID} ${BACKUP_DIR_IN_CONTAINER} && chmod 755 ${BACKUP_DIR_IN_CONTAINER}`,
  ]);
  if (mk.code !== 0) throw new Error(`mkdir /backups failed: ${mk.stderr}`);

  const applyGrants: DeployPg['applyGrants'] = (env) =>
    new Promise((resolve) => {
      const childEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        DATABASE_URL: ownerUrl(),
        DEVDIGEST_SERVER_PKG: SERVER_PKG,
      };
      if (env.appPassword !== undefined) childEnv.APP_DB_PASSWORD = env.appPassword;
      if (env.backupPassword !== undefined) childEnv.BACKUP_DB_PASSWORD = env.backupPassword;
      execFile(process.execPath, [APPLY_GRANTS], { env: childEnv, timeout: 60_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });

  const psqlOwner: DeployPg['psqlOwner'] = (db, sqlText) =>
    exec([
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '/var/run/postgresql',
      '-U',
      OWNER_USER,
      '-d',
      db,
      '-c',
      sqlText,
    ]);

  return {
    container,
    ownerUrl,
    roleUrl,
    migrate: () => runMigrations(ownerUrl()),
    applyGrants,
    exec,
    psqlOwner,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Env for running devdigest-backup.sh inside the container, as compose sets it. */
export function backupEnv(backupPassword: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGDATABASE: DB_NAME,
    PGUSER: 'devdigest_backup',
    BACKUP_DB_PASSWORD: backupPassword,
    TZ: 'UTC',
    ...extra,
  };
}
