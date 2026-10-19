import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { SecretStoreRepository } from '../src/modules/secrets/repository.js';
import { AuditRepository } from '../src/modules/audit/repository.js';
import { EncryptedSecretsProvider } from '../src/adapters/secrets/encrypted.js';
import { SecretsMaintenance, type SecretsLogger } from '../src/modules/secrets/service.js';
import { keyId } from '../src/platform/crypto/secret-box.js';

/**
 * T11 — master-key rotation against Postgres (AC-41, AC-42): with the previous
 * key configured, boot re-encrypts every row in one transaction and audits it;
 * a restart WITHOUT the previous key then reads everything as `set`.
 * Synthetic values only.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const MANAGED = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'GITLAB_TOKEN'];
const VALUES: Record<string, string> = {
  OPENAI_API_KEY: 'synthetic-openai-value-1',
  OPENROUTER_API_KEY: 'synthetic-openrouter-value-2',
  GITHUB_TOKEN: 'synthetic-github-value-3',
};

function captureLog(): SecretsLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

d('secrets rotation (Postgres)', () => {
  let pg: PgFixture;
  let store: SecretStoreRepository;
  let audit: AuditRepository;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    pg = await startPg();
    store = new SecretStoreRepository(pg.handle.db);
    audit = new AuditRepository(pg.handle.db);
    const [ws] = await pg.handle.db.insert(t.workspaces).values({ name: 'rotation-ws' }).returning();
    const [u] = await pg.handle.db.insert(t.users).values({ email: 'rot@onlytraf.com', name: 'Rot' }).returning();
    workspaceId = ws!.id;
    userId = u!.id;
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  const provider = (masterKey: Buffer) =>
    new EncryptedSecretsProvider({ store, masterKey, workspaceId, managedKeys: MANAGED });

  it('rotates every previous-key row, audits it, and a restart without the previous key reads all as set', async () => {
    const previous = randomBytes(32);
    const current = randomBytes(32);
    for (const [k, v] of Object.entries(VALUES)) await provider(previous).set(k, v, userId);

    // Before rotation, the new key alone can't read them (AC-41).
    const before = await provider(current).status(Object.keys(VALUES));
    expect([...before.values()].every((s) => s.state === 'undecryptable')).toBe(true);

    const log = captureLog();
    const boot = await new SecretsMaintenance({
      store,
      audit,
      masterKey: current,
      previousKey: previous,
      managedKeys: MANAGED,
      env: {},
      log,
    }).bootCheck();
    expect(boot.rotation).toEqual({ reencrypted: 3, failedKeyNames: [] });
    expect(boot.undecryptable).toEqual([]);
    expect(log.lines).toContain('info re-encrypted 3 secrets');

    const rows = await store.list(workspaceId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.keyId === keyId(current))).toBe(true);
    expect(rows.every((r) => r.updatedBy === userId)).toBe(true);

    const events = await pg.handle.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.action, 'secrets.reencrypt'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workspaceId, actorUserId: null });
    const dump = JSON.stringify(events);
    for (const v of Object.values(VALUES)) expect(dump).not.toContain(v);

    // "Restart" with only the current key: everything set, nothing logged as an error.
    const restartLog = captureLog();
    const again = await new SecretsMaintenance({
      store,
      audit,
      masterKey: current,
      previousKey: null,
      managedKeys: MANAGED,
      env: {},
      log: restartLog,
    }).bootCheck();
    expect(again).toEqual({ rotation: null, undecryptable: [], ignoredEnv: [] });
    expect(restartLog.lines.filter((l) => l.startsWith('error'))).toEqual([]);
    const after = await provider(current).status(Object.keys(VALUES));
    expect([...after.values()].every((s) => s.state === 'set')).toBe(true);
    for (const [k, v] of Object.entries(VALUES)) expect(await provider(current).get(k)).toBe(v);

    // Logs never carry values or key material.
    const allLogs = [...log.lines, ...restartLog.lines].join('\n');
    for (const v of Object.values(VALUES)) expect(allLogs).not.toContain(v);
    expect(allLogs).not.toContain(current.toString('base64'));
    expect(allLogs).not.toContain(previous.toString('base64'));
  });

  it('a rotation that fails mid-way writes nothing (one transaction)', async () => {
    const previous = randomBytes(32);
    const current = randomBytes(32);
    const [ws] = await pg.handle.db.insert(t.workspaces).values({ name: 'rotation-ws-2' }).returning();
    const p = new EncryptedSecretsProvider({ store, masterKey: previous, workspaceId: ws!.id, managedKeys: MANAGED });
    await p.set('OPENAI_API_KEY', 'synthetic-a');
    await p.set('GITLAB_TOKEN', 'synthetic-b');

    let calls = 0;
    const failing = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'upsert') {
          return async (...args: Parameters<SecretStoreRepository['upsert']>) => {
            calls++;
            if (calls === 2) throw new Error('injected failure');
            return target.upsert(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const m = new SecretsMaintenance({
      store: failing,
      audit,
      masterKey: current,
      previousKey: previous,
      managedKeys: MANAGED,
      env: {},
      log: captureLog(),
    });
    await expect(m.rotateIfNeeded()).rejects.toThrow('injected failure');
    const rows = await store.list(ws!.id);
    expect(rows.every((r) => r.keyId === keyId(previous))).toBe(true);
  });
});
