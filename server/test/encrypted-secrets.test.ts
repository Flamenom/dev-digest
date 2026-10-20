import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import type {
  AuditEventInput,
  AuditLog,
  EncryptedSecretRecord,
  EncryptedSecretWrite,
} from '../src/vendor/shared/auth-ports.js';
import { EncryptedSecretsProvider } from '../src/adapters/secrets/encrypted.js';
import { LocalSecretsProvider } from '../src/adapters/secrets/local.js';
import { SecretsMaintenance, type BatchSecretStore, type SecretsLogger } from '../src/modules/secrets/service.js';
import { keyId } from '../src/platform/crypto/secret-box.js';
import { SecretUndecryptableError } from '../src/platform/auth-errors.js';

/**
 * T11 — EncryptedSecretsProvider over a FAKE SecretStore (AC-36, AC-38,
 * AC-39, AC-41) + the boot-check service's pure paths. Synthetic values only.
 */

const WS = 'ws-test-1';
const MANAGED = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'GITLAB_TOKEN'];
const FAKE_VALUE = 'synthetic-test-value-0123456789abcdef';

/** In-memory SecretStore; `transaction` snapshots and restores on throw. */
class FakeStore implements BatchSecretStore<'tx'> {
  rows = new Map<string, EncryptedSecretRecord>();
  /** Every store write, in order: `upsert:<key>` or `replaceMany:<n>`. */
  writes: string[] = [];
  private k = (ws: string, key: string) => `${ws}\u0000${key}`;

  get = async (ws: string, key: string) => this.rows.get(this.k(ws, key));
  list = async (ws?: string) => [...this.rows.values()].filter((r) => !ws || r.workspaceId === ws);
  upsert = async (r: EncryptedSecretWrite) => {
    this.writes.push(`upsert:${r.keyName}`);
    this.rows.set(this.k(r.workspaceId, r.keyName), { ...r, updatedAt: new Date() });
  };
  replaceMany = async (records: readonly EncryptedSecretWrite[]) => {
    this.writes.push(`replaceMany:${records.length}`);
    for (const r of records) this.rows.set(this.k(r.workspaceId, r.keyName), { ...r, updatedAt: new Date() });
  };
  insertIfAbsent = async (r: EncryptedSecretWrite) => {
    if (this.rows.has(this.k(r.workspaceId, r.keyName))) return false;
    await this.upsert(r);
    return true;
  };
  transaction = async <T>(fn: (tx: 'tx') => Promise<T>): Promise<T> => {
    const snapshot = new Map(this.rows);
    try {
      return await fn('tx');
    } catch (err) {
      this.rows = snapshot;
      throw err;
    }
  };
}

class FakeAudit implements AuditLog<'tx'> {
  events: AuditEventInput[] = [];
  record = async (e: AuditEventInput) => {
    this.events.push(e);
  };
}

function captureLog(): SecretsLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

function provider(store: FakeStore, masterKey: Buffer) {
  return new EncryptedSecretsProvider({ store, masterKey, workspaceId: WS, managedKeys: MANAGED });
}

describe('EncryptedSecretsProvider', () => {
  it('set → get round-trips; the stored row holds no plaintext; status is set with actor + time', async () => {
    const store = new FakeStore();
    const key = randomBytes(32);
    const p = provider(store, key);
    await p.set('OPENROUTER_API_KEY', FAKE_VALUE, 'user-1');

    expect(await p.get('OPENROUTER_API_KEY')).toBe(FAKE_VALUE);

    const row = store.rows.get(`${WS}\u0000OPENROUTER_API_KEY`)!;
    expect(row.keyId).toBe(keyId(key));
    const bytes = Buffer.concat([Buffer.from(row.ciphertext), Buffer.from(row.nonce), Buffer.from(row.keyId)]);
    expect(bytes.includes(Buffer.from(FAKE_VALUE))).toBe(false);
    expect(bytes.includes(Buffer.from(FAKE_VALUE.slice(0, 12)))).toBe(false);
    expect(bytes.includes(key)).toBe(false);

    const status = await p.status(['OPENROUTER_API_KEY', 'GITHUB_TOKEN']);
    expect(status.get('OPENROUTER_API_KEY')).toMatchObject({ state: 'set', updatedBy: 'user-1' });
    expect(status.get('OPENROUTER_API_KEY')!.updatedAt).toBeInstanceOf(Date);
    expect(status.get('GITHUB_TOKEN')).toEqual({ state: 'unset', updatedAt: null, updatedBy: null });
    // A status entry never carries the value or anything derived from it.
    expect(JSON.stringify([...status.entries()])).not.toContain(FAKE_VALUE);
  });

  it('a ciphertext copied onto another key is undecryptable and get throws SecretUndecryptableError', async () => {
    const store = new FakeStore();
    const p = provider(store, randomBytes(32));
    await p.set('OPENAI_API_KEY', FAKE_VALUE);
    const src = store.rows.get(`${WS}\u0000OPENAI_API_KEY`)!;
    store.rows.set(`${WS}\u0000ANTHROPIC_API_KEY`, { ...src, keyName: 'ANTHROPIC_API_KEY' });

    expect((await p.status(['ANTHROPIC_API_KEY'])).get('ANTHROPIC_API_KEY')!.state).toBe('undecryptable');
    const err = await p.get('ANTHROPIC_API_KEY').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretUndecryptableError);
    expect((err as SecretUndecryptableError).code).toBe('secret_undecryptable');
    expect((err as Error).message).toContain('ANTHROPIC_API_KEY');
    expect((err as Error).message).toMatch(/re-enter it in Settings/);
    expect((err as Error).message).not.toContain(FAKE_VALUE);
    // The original key is still fine.
    expect(await p.get('OPENAI_API_KEY')).toBe(FAKE_VALUE);
  });

  it('a tampered ciphertext under the right key id is undecryptable', async () => {
    const store = new FakeStore();
    const p = provider(store, randomBytes(32));
    await p.set('GITLAB_TOKEN', FAKE_VALUE);
    const row = store.rows.get(`${WS}\u0000GITLAB_TOKEN`)!;
    const flipped = Buffer.from(row.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff;
    store.rows.set(`${WS}\u0000GITLAB_TOKEN`, { ...row, ciphertext: flipped });
    await expect(p.get('GITLAB_TOKEN')).rejects.toBeInstanceOf(SecretUndecryptableError);
  });

  it('a different master key → undecryptable (no env fallback), re-entering → set', async () => {
    const store = new FakeStore();
    await provider(store, randomBytes(32)).set('OPENROUTER_API_KEY', FAKE_VALUE);
    const other = provider(store, randomBytes(32));
    expect((await other.status(['OPENROUTER_API_KEY'])).get('OPENROUTER_API_KEY')!.state).toBe('undecryptable');
    await expect(other.get('OPENROUTER_API_KEY')).rejects.toBeInstanceOf(SecretUndecryptableError);

    await other.set('OPENROUTER_API_KEY', 'synthetic-replacement-value');
    expect((await other.status(['OPENROUTER_API_KEY'])).get('OPENROUTER_API_KEY')!.state).toBe('set');
    expect(await other.get('OPENROUTER_API_KEY')).toBe('synthetic-replacement-value');
  });

  it('ignores same-named env vars: GITHUB_TOKEN in env + no row → undefined, status unset', async () => {
    const prev = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GITHUB_PAT: process.env.GITHUB_PAT };
    process.env.GITHUB_TOKEN = 'synthetic-env-token';
    process.env.GITHUB_PAT = 'synthetic-env-pat';
    try {
      const p = provider(new FakeStore(), randomBytes(32));
      expect(await p.get('GITHUB_TOKEN')).toBeUndefined();
      expect((await p.status(['GITHUB_TOKEN'])).get('GITHUB_TOKEN')!.state).toBe('unset');
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('refuses unmanaged keys and resolves the workspace lazily once', async () => {
    const store = new FakeStore();
    let calls = 0;
    const p = new EncryptedSecretsProvider({
      store,
      masterKey: randomBytes(32),
      workspaceId: async () => {
        calls++;
        return WS;
      },
      managedKeys: MANAGED,
    });
    await expect(p.set('DATABASE_URL', 'x')).rejects.toThrow(/not a managed secret key/);
    expect(await p.get('DATABASE_URL')).toBeUndefined();
    await p.set('OPENAI_API_KEY', FAKE_VALUE);
    await p.get('OPENAI_API_KEY');
    expect(calls).toBe(1);
  });

  it('rejects a master key that is not 32 bytes without echoing it', () => {
    expect(() => provider(new FakeStore(), Buffer.alloc(16, 7))).toThrow(/32 bytes/);
  });
});

describe('LocalSecretsProvider.status (local mode unchanged)', () => {
  it('set when get resolves (stored or env), else unset; never undecryptable, no history', async () => {
    const p = new LocalSecretsProvider('/nonexistent/devdigest-test/secrets.json', {
      OPENAI_API_KEY: 'synthetic-env-value',
    });
    const status = await p.status(['OPENAI_API_KEY', 'GITLAB_TOKEN']);
    expect(status.get('OPENAI_API_KEY')).toEqual({ state: 'set', updatedAt: null, updatedBy: null });
    expect(status.get('GITLAB_TOKEN')).toEqual({ state: 'unset', updatedAt: null, updatedBy: null });
  });
});

describe('SecretsMaintenance (fake store)', () => {
  it('warns once per managed env var present, naming it and never its value', () => {
    const log = captureLog();
    const m = new SecretsMaintenance({
      store: new FakeStore(),
      audit: new FakeAudit(),
      masterKey: randomBytes(32),
      previousKey: null,
      managedKeys: MANAGED,
      env: { GITHUB_TOKEN: 'synthetic-env-token', OPENAI_API_KEY: '', UNRELATED: 'x', GITHUB_PAT: 'synthetic-pat' },
      log,
    });
    expect(m.warnIgnoredEnv()).toEqual(['GITHUB_TOKEN', 'GITHUB_PAT']);
    const warns = log.lines.filter((l) => l.startsWith('warn'));
    expect(warns).toHaveLength(2);
    expect(warns.filter((l) => l.includes('GITHUB_TOKEN '))).toHaveLength(1);
    expect(log.lines.join('\n')).not.toContain('synthetic');
  });

  it('reportUndecryptable logs one error naming key names only', async () => {
    const store = new FakeStore();
    const oldKey = randomBytes(32);
    await provider(store, oldKey).set('OPENROUTER_API_KEY', FAKE_VALUE);
    await provider(store, oldKey).set('GITHUB_TOKEN', FAKE_VALUE);
    const current = randomBytes(32);
    await provider(store, current).set('OPENAI_API_KEY', FAKE_VALUE);
    const log = captureLog();
    const m = new SecretsMaintenance({
      store,
      audit: new FakeAudit(),
      masterKey: current,
      previousKey: null,
      managedKeys: MANAGED,
      env: {},
      log,
    });
    const result = await m.bootCheck();
    expect(result.rotation).toBeNull();
    expect(result.undecryptable).toEqual(['GITHUB_TOKEN', 'OPENROUTER_API_KEY']);
    const errors = log.lines.filter((l) => l.startsWith('error'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('GITHUB_TOKEN');
    expect(errors[0]).toContain('OPENROUTER_API_KEY');
    expect(errors[0]).not.toContain('OPENAI_API_KEY');
    const all = log.lines.join('\n');
    expect(all).not.toContain(FAKE_VALUE);
    expect(all).not.toContain(keyId(oldKey));
    expect(all).not.toContain(current.toString('base64'));
  });

  it('rotation re-encrypts previous-key rows in one transaction and audits per workspace', async () => {
    const store = new FakeStore();
    const previous = randomBytes(32);
    const current = randomBytes(32);
    await provider(store, previous).set('OPENAI_API_KEY', FAKE_VALUE, 'user-9');
    await provider(store, previous).set('GITLAB_TOKEN', 'synthetic-gitlab-value');
    const audit = new FakeAudit();
    const log = captureLog();
    const m = new SecretsMaintenance({ store, audit, masterKey: current, previousKey: previous, managedKeys: MANAGED, env: {}, log });

    store.writes = [];
    const r = await m.rotateIfNeeded();
    expect(r).toEqual({ reencrypted: 2, failedKeyNames: [] });
    // G6: one batched replace for every row — no per-row upsert loop.
    expect(store.writes).toEqual(['replaceMany:2']);
    expect(log.lines).toContain('info re-encrypted 2 secrets');
    expect([...store.rows.values()].every((row) => row.keyId === keyId(current))).toBe(true);
    expect(store.rows.get(`${WS}\u0000OPENAI_API_KEY`)!.updatedBy).toBe('user-9');
    expect(await provider(store, current).get('OPENAI_API_KEY')).toBe(FAKE_VALUE);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ workspaceId: WS, action: 'secrets.reencrypt', actorUserId: null });
    expect(JSON.stringify(audit.events)).not.toContain(FAKE_VALUE);
  });
});
