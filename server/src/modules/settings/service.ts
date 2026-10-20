/**
 * SettingsService — the two settings writes that are audited (AC-52):
 * `settings.update` (PUT /settings) and `secret.save` (a key saved through
 * POST /settings/test-connection).
 *
 * Application ring: orchestrates the settings store, the encrypted secret
 * store and the audit log through ports; no SQL, Fastify or container here.
 *
 * Durability: the audit row is written INSIDE the transaction of the write it
 * describes (as the identity services do), so a committed write always has its
 * row and a rolled-back one never does. `secret.save` is recorded on the write
 * itself — never inferred from the HTTP status (test-connection answers 200
 * even when the save or the test fails).
 *
 * Audit metadata carries key NAMES only — never a setting or secret value.
 */
import type {
  AuditEventInput,
  AuditLog,
  EncryptedSecretWrite,
  SecretKey,
  SecretStore,
  SecretsWriter,
  Settings,
} from '@devdigest/shared';
import { rowsToSettings, type SettingsRow } from './helpers.js';

/** The settings-store slice this service needs (`SettingsRepository` fits). */
export interface SettingsStore<Tx> {
  listRows: (workspaceId: string, tx?: Tx) => Promise<SettingsRow[]>;
  upsert: (workspaceId: string, userId: string, entries: Record<string, unknown>, tx?: Tx) => Promise<void>;
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

/**
 * Google mode's encrypted secret path: `prepareWrite` seals the value (the
 * `EncryptedSecretsProvider`), the store persists it — inside the same
 * transaction as the audit row.
 */
export interface EncryptedSecretSink<Tx> {
  prepareWrite: (key: SecretKey, value: string, actorUserId: string | null) => Promise<EncryptedSecretWrite>;
  store: Pick<SecretStore<Tx>, 'upsert' | 'transaction'>;
}

/** Who performs a settings write. */
export interface SettingsActor {
  workspaceId: string;
  userId: string;
  /**
   * Audit context: the client IP for the row (google mode — an authenticated
   * principal), or null ⇒ not audited (local mode records nothing, AC-2).
   */
  audit: { ip: string | null } | null;
}

export interface SettingsServiceDeps<Tx> {
  settings: SettingsStore<Tx>;
  audit: AuditLog<Tx>;
  /** Fallback writer for non-transactional backends (local JSON file, test fakes). */
  secretsWriter: SecretsWriter;
  /** The encrypted store path, or null when the backend is not the encrypted store. */
  encryptedSecrets: EncryptedSecretSink<Tx> | null;
}

function settingsUpdateEvent(
  actor: SettingsActor,
  ip: string | null,
  entries: Record<string, unknown>,
): AuditEventInput {
  return {
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action: 'settings.update',
    targetType: 'settings',
    targetId: null,
    metadata: { changed_keys: Object.keys(entries).sort() },
    ip,
  };
}

function secretSaveEvent(actor: SettingsActor, ip: string | null, key: SecretKey): AuditEventInput {
  return {
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action: 'secret.save',
    targetType: 'secret',
    targetId: key,
    metadata: { key_name: key },
    ip,
  };
}

export class SettingsService<Tx> {
  constructor(private readonly deps: SettingsServiceDeps<Tx>) {}

  /** The workspace's non-secret prefs. */
  async list(workspaceId: string): Promise<Settings> {
    return rowsToSettings(await this.deps.settings.listRows(workspaceId));
  }

  /** Set prefs workspace-wide (Q8) and audit the changed key NAMES in the same transaction. */
  async update(actor: SettingsActor, entries: Record<string, unknown>): Promise<Settings> {
    const { settings, audit } = this.deps;
    await settings.transaction(async (tx) => {
      await settings.upsert(actor.workspaceId, actor.userId, entries, tx);
      if (actor.audit) await audit.record(settingsUpdateEvent(actor, actor.audit.ip, entries), tx);
    });
    return this.list(actor.workspaceId);
  }

  /**
   * Persist a secret value and audit `secret.save` with the write: on the
   * encrypted store both rows commit (or roll back) together. A backend
   * outside the database (local JSON file) cannot share a transaction; there
   * the event is recorded right after the write succeeded — never for a write
   * that failed.
   */
  async saveSecret(actor: SettingsActor, key: SecretKey, value: string): Promise<void> {
    const event = actor.audit ? secretSaveEvent(actor, actor.audit.ip, key) : null;
    const encrypted = this.deps.encryptedSecrets;
    if (encrypted) {
      const write = await encrypted.prepareWrite(key, value, actor.userId);
      await encrypted.store.transaction(async (tx) => {
        await encrypted.store.upsert(write, tx);
        if (event) await this.deps.audit.record(event, tx);
      });
      return;
    }
    await this.deps.secretsWriter.set(key, value, actor.userId);
    if (event) await this.deps.audit.record(event);
  }
}
