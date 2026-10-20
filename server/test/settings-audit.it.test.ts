import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import type { AuditLog } from '../src/vendor/shared/auth-ports.js';
import { AuditRepository, type AuditTx } from '../src/modules/audit/repository.js';
import { SettingsRepository, type SettingsTx } from '../src/modules/settings/repository.js';
import { SettingsService, type SettingsActor } from '../src/modules/settings/service.js';
import { SecretStoreRepository } from '../src/modules/secrets/repository.js';
import { EncryptedSecretsProvider } from '../src/adapters/secrets/encrypted.js';

/**
 * G4 — `settings.update` / `secret.save` audit rows are written INSIDE the
 * write's transaction (real Postgres): present as soon as the service call
 * returns (no fire-and-forget hook to wait for), and rolled back together with
 * the write when anything in the transaction fails.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const MANAGED = ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'GITLAB_TOKEN'];
const SECRET = 'synthetic-secret-value-0123456789';

d('settings audit durability (G4)', () => {
  let pg: PgFixture;
  let ws: string;
  let actor: SettingsActor;
  let settingsRepo: SettingsRepository;
  let audit: AuditRepository;
  let store: SecretStoreRepository;
  let provider: EncryptedSecretsProvider;

  beforeAll(async () => {
    pg = await startPg();
    const [w] = await pg.handle.db.insert(t.workspaces).values({ name: 'settings-audit-ws' }).returning();
    const [u] = await pg.handle.db
      .insert(t.users)
      .values({ email: 'settings-audit-admin@onlytraf.com', name: 'Admin' })
      .returning();
    if (!w || !u) throw new Error('fixture rows were not created');
    ws = w.id;
    actor = { workspaceId: ws, userId: u.id, audit: { ip: '198.51.100.9' } };
    settingsRepo = new SettingsRepository(pg.handle.db);
    audit = new AuditRepository(pg.handle.db);
    store = new SecretStoreRepository(pg.handle.db);
    provider = new EncryptedSecretsProvider({
      store,
      masterKey: randomBytes(32),
      workspaceId: ws,
      managedKeys: MANAGED,
    });
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  /** A service over the real repositories; `auditLog` lets a test inject a failure. */
  function service(auditLog: AuditLog<SettingsTx> = audit) {
    return new SettingsService<SettingsTx>({
      settings: settingsRepo,
      audit: auditLog,
      secretsWriter: { set: async () => undefined },
      encryptedSecrets: {
        prepareWrite: (key, value, actorUserId) => provider.prepareWrite(key, value, actorUserId),
        store,
      },
    });
  }

  /** Writes the real row, then fails — inside the caller's transaction. */
  const failingAfterWrite: AuditLog<AuditTx> = {
    record: async (event, tx) => {
      await audit.record(event, tx);
      throw new Error('injected failure after the audit insert');
    },
  };

  const auditRows = (action: string) =>
    pg.handle.db
      .select()
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.workspaceId, ws), eq(t.auditEvents.action, action)));

  it('settings.update: the row exists right after the call; a failure rolls back setting + audit', async () => {
    await service().update(actor, { theme: 'dark' });
    const rows = await auditRows('settings.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: actor.userId,
      targetType: 'settings',
      targetId: null,
      metadata: { changed_keys: ['theme'] },
      ip: '198.51.100.9',
    });

    await expect(service(failingAfterWrite).update(actor, { theme: 'light', density: 'compact' })).rejects.toThrow(
      'injected failure',
    );
    expect(await auditRows('settings.update')).toHaveLength(1);
    const settings = await settingsRepo.listRows(ws);
    expect(settings).toEqual([{ key: 'theme', value: 'dark' }]); // neither key of the failed batch landed
  });

  it('secret.save: the encrypted row and its audit row commit — or roll back — together', async () => {
    await service().saveSecret(actor, 'GITHUB_TOKEN', SECRET);
    expect(await provider.get('GITHUB_TOKEN')).toBe(SECRET);
    const rows = await auditRows('secret.save');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: actor.userId,
      targetType: 'secret',
      targetId: 'GITHUB_TOKEN',
      metadata: { key_name: 'GITHUB_TOKEN' },
    });
    expect(JSON.stringify(rows)).not.toContain(SECRET);

    await expect(service(failingAfterWrite).saveSecret(actor, 'GITLAB_TOKEN', SECRET)).rejects.toThrow(
      'injected failure',
    );
    expect(await store.get(ws, 'GITLAB_TOKEN')).toBeUndefined();
    expect(await auditRows('secret.save')).toHaveLength(1);
  });
});
