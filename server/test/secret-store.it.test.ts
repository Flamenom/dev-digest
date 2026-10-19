import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { SecretStoreRepository } from '../src/modules/secrets/repository.js';
import type { EncryptedSecretWrite } from '../src/vendor/shared/auth-ports.js';

/**
 * T8 — encrypted secret store rows (AC-36/AC-40 atomic replace half): upsert is
 * one atomic statement, `insertIfAbsent` never overwrites, `(workspace, key)` is
 * unique, bytes round-trip as Buffers, and `transaction`/`replaceMany` are
 * all-or-nothing.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

function write(workspaceId: string, keyName: string, keyId = 'k1', updatedBy: string | null = null): EncryptedSecretWrite {
  return { workspaceId, keyName, ciphertext: randomBytes(32), nonce: randomBytes(12), keyId, updatedBy };
}

d('SecretStoreRepository', () => {
  let pg: PgFixture;
  let repo: SecretStoreRepository;
  let ws1: string;
  let ws2: string;
  let userId: string;

  beforeAll(async () => {
    pg = await startPg();
    repo = new SecretStoreRepository(pg.handle.db);
    const [a, b] = await pg.handle.db.insert(t.workspaces).values([{ name: 'ws1' }, { name: 'ws2' }]).returning();
    const [u] = await pg.handle.db.insert(t.users).values({ email: 'admin@onlytraf.com', name: 'Admin' }).returning();
    ws1 = a!.id;
    ws2 = b!.id;
    userId = u!.id;
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('upsert inserts then replaces in place; bytes round-trip as Buffers', async () => {
    const first = write(ws1, 'GITHUB_TOKEN', 'k1', null);
    await repo.upsert(first);
    const got = await repo.get(ws1, 'GITHUB_TOKEN');
    expect(got).toBeDefined();
    expect(Buffer.isBuffer(got!.ciphertext)).toBe(true);
    expect(Buffer.from(got!.ciphertext).equals(Buffer.from(first.ciphertext))).toBe(true);
    expect(Buffer.from(got!.nonce).equals(Buffer.from(first.nonce))).toBe(true);
    expect(got).toMatchObject({ workspaceId: ws1, keyName: 'GITHUB_TOKEN', keyId: 'k1', updatedBy: null });

    const second = write(ws1, 'GITHUB_TOKEN', 'k2', userId);
    await repo.upsert(second);
    const replaced = await repo.get(ws1, 'GITHUB_TOKEN');
    expect(Buffer.from(replaced!.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(true);
    expect(replaced).toMatchObject({ keyId: 'k2', updatedBy: userId });
    expect(replaced!.updatedAt.getTime()).toBeGreaterThanOrEqual(got!.updatedAt.getTime());
    expect(await repo.list(ws1)).toHaveLength(1);
  });

  it('concurrent upserts on one key converge on exactly one row (atomic)', async () => {
    const writes = Array.from({ length: 8 }, () => write(ws1, 'OPENROUTER_API_KEY'));
    await Promise.all(writes.map((w) => repo.upsert(w)));
    const rows = (await repo.list(ws1)).filter((r) => r.keyName === 'OPENROUTER_API_KEY');
    expect(rows).toHaveLength(1);
    const stored = Buffer.from(rows[0]!.ciphertext);
    expect(writes.some((w) => Buffer.from(w.ciphertext).equals(stored))).toBe(true);
  });

  it('insertIfAbsent does not overwrite an existing row', async () => {
    const original = write(ws1, 'GITLAB_TOKEN', 'k1', userId);
    expect(await repo.insertIfAbsent(original)).toBe(true);
    expect(await repo.insertIfAbsent(write(ws1, 'GITLAB_TOKEN', 'k-import'))).toBe(false);
    const got = await repo.get(ws1, 'GITLAB_TOKEN');
    expect(Buffer.from(got!.ciphertext).equals(Buffer.from(original.ciphertext))).toBe(true);
    expect(got).toMatchObject({ keyId: 'k1', updatedBy: userId });
  });

  it('keys are unique per workspace, not globally; list scopes by workspace', async () => {
    await repo.upsert(write(ws2, 'GITHUB_TOKEN', 'k1'));
    expect(await repo.insertIfAbsent(write(ws2, 'GITLAB_TOKEN'))).toBe(true);
    const ws2Names = (await repo.list(ws2)).map((r) => r.keyName);
    expect(ws2Names).toEqual(['GITHUB_TOKEN', 'GITLAB_TOKEN']);
    expect((await repo.list(ws1)).every((r) => r.workspaceId === ws1)).toBe(true);
    const all = await repo.list();
    expect(all.length).toBe((await repo.list(ws1)).length + ws2Names.length);
    expect(await repo.get(ws2, 'OPENROUTER_API_KEY')).toBeUndefined();

    // The DB-level unique index holds even when bypassing the repository.
    const raw = write(ws2, 'GITHUB_TOKEN');
    await expect(
      pg.handle.db.insert(t.encryptedSecrets).values({
        ...raw,
        ciphertext: Buffer.from(raw.ciphertext),
        nonce: Buffer.from(raw.nonce),
      }),
    ).rejects.toThrow();
  });

  it('rejects a malformed nonce before SQL without echoing bytes', async () => {
    const bad = { ...write(ws1, 'BAD_KEY'), nonce: Buffer.from('short') };
    await expect(repo.upsert(bad)).rejects.toThrow(/BAD_KEY: nonce must be 12 bytes/);
    expect(await repo.get(ws1, 'BAD_KEY')).toBeUndefined();
  });

  it('listByKeyId + replaceMany re-key rows all-or-nothing', async () => {
    const before = await repo.listByKeyId('k1', ws2);
    expect(before.map((r) => r.keyName)).toEqual(['GITHUB_TOKEN', 'GITLAB_TOKEN']);

    // One invalid record aborts the whole batch (validated up front).
    const rekeyed = before.map((r) => write(r.workspaceId, r.keyName, 'k9', userId));
    await expect(repo.replaceMany([...rekeyed, { ...rekeyed[0]!, nonce: Buffer.alloc(3) }])).rejects.toThrow();
    expect(await repo.listByKeyId('k9', ws2)).toHaveLength(0);

    await repo.replaceMany(rekeyed);
    expect(await repo.listByKeyId('k1', ws2)).toHaveLength(0);
    expect((await repo.listByKeyId('k9', ws2)).map((r) => r.keyName)).toEqual(['GITHUB_TOKEN', 'GITLAB_TOKEN']);
  });

  it('transaction rolls back every write on failure', async () => {
    await expect(
      repo.transaction(async (tx) => {
        expect(await repo.insertIfAbsent(write(ws2, 'TX_A'), tx)).toBe(true);
        await repo.upsert(write(ws2, 'TX_B'), tx);
        expect(await repo.get(ws2, 'TX_A', tx)).toBeDefined();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await repo.get(ws2, 'TX_A')).toBeUndefined();
    expect(await repo.get(ws2, 'TX_B')).toBeUndefined();
  });
});
