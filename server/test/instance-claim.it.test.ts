import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { dockerAvailable, startEmptyPg, type EmptyPgFixture } from './helpers/pg.js';
import {
  claimInstance,
  INSTANCE_CLAIM_CONFLICT_MESSAGE,
  INSTANCE_CLAIM_LOCK_KEY,
} from '../src/db/instance-claim.js';

/**
 * AC-5 mechanism (boot wiring is T21). The claim needs no table, so this test
 * uses a bare container — no migrations — and is independent of schema work.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[instance-claim] Docker not available — skipping Testcontainers tests.');
}

d('claimInstance (single-instance DB claim)', () => {
  let container: EmptyPgFixture;
  let url: string;
  let observer: postgres.Sql;

  /**
   * Advisory locks on our key currently held by any session IN THIS DATABASE.
   * The cluster is shared across test files (one DB each) and pg_locks is
   * cluster-wide; advisory locks themselves are per-database, so filter by it.
   */
  async function heldCount(): Promise<number> {
    const rows = await observer<{ count: number }[]>`
      select count(*)::int as count from pg_locks
      where locktype = 'advisory' and granted
        and database = (select oid from pg_database where datname = current_database())
        and ((classid::bigint << 32) | objid::bigint) = ${INSTANCE_CLAIM_LOCK_KEY}::bigint`;
    return rows[0]!.count;
  }

  beforeAll(async () => {
    container = await startEmptyPg();
    url = container.url;
    observer = postgres(url, { max: 1 });
  });

  afterAll(async () => {
    await observer?.end({ timeout: 5 });
    await container?.stop();
  });

  it('A claims, B is refused, after A.release() B claims', async () => {
    const a = await claimInstance(url);
    expect(await heldCount()).toBe(1);

    await expect(claimInstance(url)).rejects.toMatchObject({
      code: 'config_error',
      message: INSTANCE_CLAIM_CONFLICT_MESSAGE,
    });
    // The refused claimant does not leak a lock or keep its connection.
    expect(await heldCount()).toBe(1);

    await a.release();
    await a.release(); // idempotent
    expect(await heldCount()).toBe(0);

    const b = await claimInstance(url);
    expect(await heldCount()).toBe(1);
    await b.release();
    expect(await heldCount()).toBe(0);
  });

  it('a dead holder session frees the claim (no stale lock)', async () => {
    const a = await claimInstance(url);
    // Simulate the holder process dying: kill its backend from outside.
    await observer`
      select pg_terminate_backend(pid) from pg_stat_activity
      where application_name = 'devdigest-instance-claim' and datname = current_database()`;
    await expect.poll(heldCount, { timeout: 5000 }).toBe(0);

    const b = await claimInstance(url);
    expect(await heldCount()).toBe(1);
    await b.release();
    await a.release(); // releasing a dead claim must not throw
  });
});
