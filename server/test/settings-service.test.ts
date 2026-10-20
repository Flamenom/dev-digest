import { describe, it, expect } from 'vitest';
import type {
  AuditEventInput,
  AuditLog,
  EncryptedSecretWrite,
  SecretKey,
} from '../src/vendor/shared/auth-ports.js';
import {
  SettingsService,
  type EncryptedSecretSink,
  type SettingsActor,
  type SettingsStore,
} from '../src/modules/settings/service.js';
import type { SettingsRow } from '../src/modules/settings/helpers.js';

/**
 * G4 — audit durability for `settings.update` / `secret.save`, hermetic: one
 * in-memory "database" (settings rows + secret rows + audit rows) whose
 * `transaction` snapshots everything and restores it on throw, so the tests
 * observe exactly what would commit.
 */

type Tx = { readonly id: number };

class FakeDb {
  settings = new Map<string, unknown>();
  secrets = new Map<string, EncryptedSecretWrite>();
  audit: Array<AuditEventInput & { tx: Tx | undefined }> = [];
  failAudit = false;
  failSecretUpsert = false;
  private txSeq = 0;

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const snapshot = { settings: new Map(this.settings), secrets: new Map(this.secrets), audit: [...this.audit] };
    try {
      return await fn({ id: ++this.txSeq });
    } catch (err) {
      Object.assign(this, snapshot);
      throw err;
    }
  }

  settingsStore(): SettingsStore<Tx> {
    return {
      listRows: async (): Promise<SettingsRow[]> =>
        [...this.settings].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })),
      upsert: async (_ws, _user, entries) => {
        for (const [k, v] of Object.entries(entries)) this.settings.set(k, v);
      },
      transaction: (fn) => this.transaction(fn),
    };
  }

  auditLog(): AuditLog<Tx> {
    return {
      record: async (event, tx) => {
        if (this.failAudit) throw new Error('audit store down');
        this.audit.push({ ...event, tx });
      },
    };
  }

  encrypted(): EncryptedSecretSink<Tx> {
    return {
      prepareWrite: async (key: SecretKey, value: string, actorUserId) => ({
        workspaceId: 'ws-1',
        keyName: key,
        ciphertext: Buffer.from(`sealed:${value.length}`),
        nonce: Buffer.alloc(12),
        keyId: 'k1',
        updatedBy: actorUserId,
      }),
      store: {
        upsert: async (record) => {
          if (this.failSecretUpsert) throw new Error('constraint violation');
          this.secrets.set(record.keyName, record);
        },
        transaction: (fn) => this.transaction(fn),
      },
    };
  }
}

const ADMIN: SettingsActor = { workspaceId: 'ws-1', userId: 'user-1', audit: { ip: '203.0.113.7' } };
const LOCAL: SettingsActor = { workspaceId: 'ws-1', userId: 'system', audit: null };
const SECRET = 'sk-test-value-never-audited';

function service(db: FakeDb, opts: { encrypted?: boolean; plainSet?: (k: SecretKey, v: string) => Promise<void> } = {}) {
  const plainWrites: string[] = [];
  const svc = new SettingsService<Tx>({
    settings: db.settingsStore(),
    audit: db.auditLog(),
    secretsWriter: {
      set: opts.plainSet ?? (async (key) => void plainWrites.push(key)),
    },
    encryptedSecrets: opts.encrypted === false ? null : db.encrypted(),
  });
  return { svc, plainWrites };
}

describe('SettingsService.update — settings.update audited in the write transaction (G4)', () => {
  it('commits the settings and its audit row together, in the same transaction, key NAMES only', async () => {
    const db = new FakeDb();
    const { svc } = service(db);
    const out = await svc.update(ADMIN, { theme: 'dark', density: 'compact' });
    expect(out).toMatchObject({ theme: 'dark', density: 'compact' });
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      action: 'settings.update',
      targetType: 'settings',
      targetId: null,
      metadata: { changed_keys: ['density', 'theme'] },
      ip: '203.0.113.7',
    });
    expect(db.audit[0]!.tx).toBeDefined(); // joined the write's transaction
    expect(JSON.stringify(db.audit)).not.toContain('dark');
  });

  it('a failing audit write rolls the settings change back; local mode records nothing', async () => {
    const db = new FakeDb();
    const { svc } = service(db);
    db.failAudit = true;
    await expect(svc.update(ADMIN, { theme: 'dark' })).rejects.toThrow('audit store down');
    expect(db.settings.size).toBe(0);
    expect(db.audit).toHaveLength(0);

    db.failAudit = false;
    await svc.update(LOCAL, { theme: 'light' });
    expect(db.settings.get('theme')).toBe('light');
    expect(db.audit).toHaveLength(0);
  });
});

describe('SettingsService.saveSecret — secret.save audited on the write itself (G4)', () => {
  it('encrypted store: row + audit commit together; either failing rolls both back', async () => {
    const db = new FakeDb();
    const { svc, plainWrites } = service(db);

    await svc.saveSecret(ADMIN, 'GITHUB_TOKEN', SECRET);
    expect(db.secrets.get('GITHUB_TOKEN')).toMatchObject({ updatedBy: 'user-1' });
    expect(db.audit).toEqual([
      expect.objectContaining({
        action: 'secret.save',
        targetType: 'secret',
        targetId: 'GITHUB_TOKEN',
        metadata: { key_name: 'GITHUB_TOKEN' },
        actorUserId: 'user-1',
        ip: '203.0.113.7',
      }),
    ]);
    expect(db.audit[0]!.tx).toBeDefined();
    expect(plainWrites).toEqual([]); // the encrypted path never touches the plain writer
    expect(JSON.stringify(db.audit)).not.toContain(SECRET);

    // Audit fails → the secret row rolls back with it.
    db.failAudit = true;
    await expect(svc.saveSecret(ADMIN, 'GITLAB_TOKEN', SECRET)).rejects.toThrow('audit store down');
    expect(db.secrets.has('GITLAB_TOKEN')).toBe(false);

    // The write fails → no audit row.
    db.failAudit = false;
    db.failSecretUpsert = true;
    await expect(svc.saveSecret(ADMIN, 'OPENAI_API_KEY', SECRET)).rejects.toThrow('constraint violation');
    expect(db.secrets.has('OPENAI_API_KEY')).toBe(false);
    expect(db.audit).toHaveLength(1);
  });

  it('plain writer (non-DB backend): audited only after a successful write; local mode never audited', async () => {
    const db = new FakeDb();
    const failing = service(db, {
      encrypted: false,
      plainSet: async () => {
        throw new Error('read-only file');
      },
    });
    await expect(failing.svc.saveSecret(ADMIN, 'GITHUB_TOKEN', SECRET)).rejects.toThrow('read-only file');
    expect(db.audit).toHaveLength(0);

    const ok = service(db, { encrypted: false });
    await ok.svc.saveSecret(ADMIN, 'GITHUB_TOKEN', SECRET);
    expect(ok.plainWrites).toEqual(['GITHUB_TOKEN']);
    expect(db.audit).toEqual([expect.objectContaining({ action: 'secret.save', targetId: 'GITHUB_TOKEN' })]);

    await ok.svc.saveSecret(LOCAL, 'OPENAI_API_KEY', SECRET);
    expect(ok.plainWrites).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    expect(db.audit).toHaveLength(1);
  });
});
