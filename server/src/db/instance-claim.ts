import postgres from 'postgres';
import { ConfigError } from '../platform/errors.js';

/**
 * Single-instance DB claim (spec AC-5). Per-process sync single-flight, the
 * in-memory run event bus and stale-run reaping on boot all assume exactly one
 * API process per database, so in multi-user mode boot takes an exclusive claim.
 *
 * Mechanism: a SESSION-level Postgres advisory lock held on a dedicated,
 * single-connection postgres-js client for the process lifetime. No table, so
 * no migration. A pooled connection would silently drop the lock when the pool
 * recycles it — hence `max: 1` + `idle_timeout: 0` + `max_lifetime: null`, and
 * the client is never shared. If the process dies, Postgres ends the session
 * and the lock is freed automatically (no stale claim to clean up).
 *
 * Wiring into boot (and release on Fastify `onClose`) is T21.
 */

/**
 * Fixed 64-bit advisory-lock key — ASCII "DevDiAPI" (0x4465764469415049).
 * Passed as a string + `::bigint` cast: it exceeds Number.MAX_SAFE_INTEGER.
 */
export const INSTANCE_CLAIM_LOCK_KEY = '4928475403422617673';

export const INSTANCE_CLAIM_CONFLICT_MESSAGE = 'another DevDigest API instance is running';

export interface InstanceClaim {
  /** Unlock and close the dedicated connection. Idempotent. */
  release: () => Promise<void>;
}

export async function claimInstance(databaseUrl: string): Promise<InstanceClaim> {
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    // Distinguishable in pg_stat_activity.
    connection: { application_name: 'devdigest-instance-claim' },
  });

  let acquired: boolean;
  try {
    // postgres-js connects lazily — this query opens the session eagerly.
    const rows = await sql<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(${INSTANCE_CLAIM_LOCK_KEY}::bigint) as acquired`;
    acquired = rows[0]?.acquired === true;
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    throw err;
  }

  if (!acquired) {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    throw new ConfigError(INSTANCE_CLAIM_CONFLICT_MESSAGE);
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await sql`select pg_advisory_unlock(${INSTANCE_CLAIM_LOCK_KEY}::bigint)`;
      } catch {
        // Ending the session below frees the lock regardless.
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  };
}
