import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { bootstrap } from '../src/db/bootstrap.js';
import { DEFAULT_WORKSPACE_NAME, SYSTEM_USER_EMAIL } from '../src/db/seed.js';

/**
 * `pnpm db:bootstrap` (Q5): tenancy-only, idempotent production bootstrap —
 * default workspace + system user + its Admin membership, and nothing else.
 */

const execFileP = promisify(execFile);
const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('db bootstrap', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('creates exactly one workspace, system user and admin membership, idempotently', async () => {
    const db = pg.handle.db;

    const first = await bootstrap(db);
    expect(first.created).toEqual({ workspace: true, user: true, membership: true });

    const second = await bootstrap(db);
    expect(second).toEqual({
      workspaceId: first.workspaceId,
      userId: first.userId,
      created: { workspace: false, user: false, membership: false },
    });

    // Concurrent runs are serialized and still converge on the same rows.
    const concurrent = await Promise.all([bootstrap(db), bootstrap(db)]);
    for (const r of concurrent) {
      expect(r.workspaceId).toBe(first.workspaceId);
      expect(r.userId).toBe(first.userId);
    }

    const workspaces = await db.select().from(t.workspaces);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.name).toBe(DEFAULT_WORKSPACE_NAME);

    const users = await db.select().from(t.users);
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe(SYSTEM_USER_EMAIL);
    expect(users[0]!.googleSub).toBeNull();

    const members = await db.select().from(t.workspaceMembers);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      workspaceId: first.workspaceId,
      userId: first.userId,
      role: 'admin',
      status: 'active',
    });

    expect(await db.select().from(t.repos)).toHaveLength(0);
    expect(await db.select().from(t.agents)).toHaveLength(0);
  });

  it('never overrides an existing membership role', async () => {
    const db = pg.handle.db;
    const { workspaceId, userId } = await bootstrap(db);
    await db
      .update(t.workspaceMembers)
      .set({ role: 'member' })
      .where(eq(t.workspaceMembers.userId, userId));

    const r = await bootstrap(db);
    expect(r.created.membership).toBe(false);
    const [m] = await db
      .select()
      .from(t.workspaceMembers)
      .where(eq(t.workspaceMembers.workspaceId, workspaceId));
    expect(m!.role).toBe('member');
  });

  it('CLI runs with a DATABASE_URL-only env (no Google / master-key settings)', async () => {
    // Mirrors the deploy `migrate` service env: NODE_ENV + DATABASE_URL only.
    // DOTENV_CONFIG_PATH points nowhere so a developer's server/.env cannot
    // mask a regression that starts reading the full app config.
    const { stdout } = await execFileP(
      process.execPath,
      ['--import', 'tsx', 'src/db/bootstrap.ts'],
      {
        cwd: SERVER_DIR,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'production',
          AUTH_MODE: 'google',
          DATABASE_URL: pg.url,
          DOTENV_CONFIG_PATH: join(SERVER_DIR, '.env.does-not-exist'),
        },
        timeout: 60_000,
      },
    );
    expect(stdout).toContain('bootstrapped');
    const workspaces = await pg.handle.db.select().from(t.workspaces);
    expect(workspaces).toHaveLength(1);
  }, 90_000);
});
