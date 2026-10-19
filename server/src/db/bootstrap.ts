import 'dotenv/config';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import * as t from './schema.js';
import { DEFAULT_WORKSPACE_NAME, SYSTEM_USER_EMAIL } from './seed.js';

/**
 * Production tenancy bootstrap (`pnpm db:bootstrap`, run by the deploy migration
 * step after `db:migrate`). Creates ONLY what google mode needs to boot: the
 * default workspace, the seeded system user (the "Local user" actor) and its
 * Admin membership. No demo repos/PRs/reviews and — because `seed()` builds the
 * built-in agents/skills inline rather than through separable helpers — no
 * built-in agents or skills either (tenancy only; run `db:seed` for the demo).
 *
 * Idempotent: lookups by the same natural keys `seed()` uses (workspace name,
 * system user email); an existing membership is never altered (a role chosen by
 * an Admin is not overridden). Serialized by a transaction-scoped advisory lock
 * so two concurrent runs cannot create two default workspaces (the name has no
 * unique constraint).
 *
 * Env contract (least privilege, deploy `migrate` service): the CLI reads ONLY
 * `DATABASE_URL`. It must never call `loadConfig()` — in google mode that would
 * demand the Google client secret and the secrets master key, which the
 * migrate container deliberately does not receive. Pinned by
 * test/db-bootstrap.it.test.ts (CLI run with a DATABASE_URL-only env).
 */
export interface BootstrapResult {
  workspaceId: string;
  userId: string;
  created: { workspace: boolean; user: boolean; membership: boolean };
}

/** Fixed advisory-lock key for the bootstrap critical section. */
const BOOTSTRAP_LOCK_KEY = 'devdigest:db-bootstrap';

export async function bootstrap(db: Db): Promise<BootstrapResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${BOOTSTRAP_LOCK_KEY}))`);

    let workspaceCreated = false;
    let [ws] = await tx
      .select({ id: t.workspaces.id })
      .from(t.workspaces)
      .where(eq(t.workspaces.name, DEFAULT_WORKSPACE_NAME))
      .orderBy(t.workspaces.createdAt)
      .limit(1);
    if (!ws) {
      [ws] = await tx
        .insert(t.workspaces)
        .values({ name: DEFAULT_WORKSPACE_NAME })
        .returning({ id: t.workspaces.id });
      workspaceCreated = true;
    }

    let userCreated = false;
    let [user] = await tx
      .select({ id: t.users.id })
      .from(t.users)
      .where(eq(t.users.email, SYSTEM_USER_EMAIL))
      .orderBy(t.users.createdAt)
      .limit(1);
    if (!user) {
      [user] = await tx
        .insert(t.users)
        .values({ email: SYSTEM_USER_EMAIL, name: 'You' })
        .returning({ id: t.users.id });
      userCreated = true;
    }

    const inserted = await tx
      .insert(t.workspaceMembers)
      .values({ workspaceId: ws!.id, userId: user!.id, role: 'admin', joinedAt: new Date() })
      .onConflictDoNothing()
      .returning({ userId: t.workspaceMembers.userId });

    return {
      workspaceId: ws!.id,
      userId: user!.id,
      created: { workspace: workspaceCreated, user: userCreated, membership: inserted.length > 0 },
    };
  });
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const handle = createDb(url, { max: 1 });
  bootstrap(handle.db)
    .then(async (r) => {
      console.log('✓ bootstrapped', r);
      await handle.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('✗ bootstrap failed:', err);
      await handle.close();
      process.exit(1);
    });
}
