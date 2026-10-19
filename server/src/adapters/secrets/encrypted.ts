import type {
  EncryptedSecretRecord,
  SecretKey,
  SecretKeyStatus,
  SecretStore,
  SecretsInspector,
  SecretsProvider,
  SecretsWriter,
} from '@devdigest/shared';
import { aadFor, keyId, open, seal } from '../../platform/crypto/secret-box.js';
import { SecretUndecryptableError } from '../../platform/auth-errors.js';

/**
 * EncryptedSecretsProvider — google-mode secrets backend (AC-36…AC-41).
 *
 * Managed keys (the Settings → API Keys set, injected by the composition root)
 * live ONLY in the `SecretStore` as AES-256-GCM ciphertext bound to their
 * (workspace, key name) slot. This adapter never consults `process.env` (AC-39):
 * an absent row is simply `undefined`. A row written under another master key,
 * or one whose ciphertext fails authentication (tampered / moved onto another
 * key's row), is `undecryptable`: `get` throws {@link SecretUndecryptableError}
 * naming the KEY only — it never falls back to env or another credential (AC-41).
 *
 * No SQL here: rows go through the `SecretStore` port. No caching: every `get`
 * reads the current row, so a value replaced via `set` is used by the next call
 * without a restart (AC-40). Plaintext, ciphertext and key material never appear
 * in an error or log line.
 */
/**
 * The slice of the store this adapter uses. `Tx = never`: the provider never
 * joins a caller's transaction, so any `SecretStore<Tx>` fits.
 */
export type ProviderSecretStore = Pick<SecretStore<never>, 'get' | 'list' | 'upsert'>;

export interface EncryptedSecretsDeps {
  store: ProviderSecretStore;
  /** Current 32-byte master key (config.masterKey). Never logged. */
  masterKey: Buffer;
  /**
   * The team workspace that scopes every row (AAD + store key). A resolver is
   * accepted so the container can look it up lazily; it is cached after the
   * first successful call.
   */
  workspaceId: string | (() => Promise<string>);
  /** The managed key names (`SECRET_KEY_BY_PROVIDER` values). */
  managedKeys: readonly SecretKey[];
}

export class EncryptedSecretsProvider implements SecretsProvider, SecretsWriter, SecretsInspector {
  private readonly store: ProviderSecretStore;
  private readonly masterKey: Buffer;
  private readonly currentKeyId: string;
  private readonly managed: ReadonlySet<string>;
  private readonly resolveWorkspace: () => Promise<string>;
  private workspaceIdCache: string | undefined;

  constructor(deps: EncryptedSecretsDeps) {
    this.store = deps.store;
    this.masterKey = deps.masterKey;
    // Validates the key length up front (throws without echoing the key).
    this.currentKeyId = keyId(deps.masterKey);
    this.managed = new Set(deps.managedKeys);
    const ws = deps.workspaceId;
    this.resolveWorkspace = typeof ws === 'string' ? async () => ws : ws;
  }

  private async workspaceId(): Promise<string> {
    this.workspaceIdCache ??= await this.resolveWorkspace();
    return this.workspaceIdCache;
  }

  /** Decrypt one row, or null when it is not decryptable under the current key. */
  private tryOpen(record: EncryptedSecretRecord): string | null {
    if (record.keyId !== this.currentKeyId) return null;
    try {
      return open(
        { ciphertext: Buffer.from(record.ciphertext), nonce: Buffer.from(record.nonce) },
        this.masterKey,
        aadFor(record.workspaceId, record.keyName),
      );
    } catch {
      return null;
    }
  }

  async get(key: SecretKey): Promise<string | undefined> {
    if (!this.managed.has(key)) return undefined;
    const record = await this.store.get(await this.workspaceId(), key);
    if (!record) return undefined;
    const value = this.tryOpen(record);
    if (value === null) throw new SecretUndecryptableError(key);
    return value;
  }

  /**
   * Encrypt and atomically replace the row (one upsert). Satisfies both the
   * optional `SecretsProvider.set(key, value)` and `SecretsWriter.set(key,
   * value, actorUserId)`; the actor defaults to null (no authenticated user).
   */
  async set(key: SecretKey, value: string, actorUserId: string | null = null): Promise<void> {
    if (!this.managed.has(key)) {
      throw new Error(`${key} is not a managed secret key`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${key} must be a non-empty string`);
    }
    const workspaceId = await this.workspaceId();
    const sealed = seal(value, this.masterKey, aadFor(workspaceId, key));
    await this.store.upsert({
      workspaceId,
      keyName: key,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      keyId: this.currentKeyId,
      updatedBy: actorUserId,
    });
  }

  /**
   * Per-key state (AC-38): `set` only when the row decrypts under the current
   * master key; `undecryptable` for a key-id mismatch or failed authentication;
   * `unset` when there is no row (or the key is not managed). Never returns the
   * value or anything derived from it.
   */
  status = async (keys: readonly SecretKey[]): Promise<Map<SecretKey, SecretKeyStatus>> => {
    const rows = await this.store.list(await this.workspaceId());
    const byName = new Map(rows.map((r) => [r.keyName, r]));
    const out = new Map<SecretKey, SecretKeyStatus>();
    for (const key of keys) {
      const record = this.managed.has(key) ? byName.get(key) : undefined;
      if (!record) {
        out.set(key, { state: 'unset', updatedAt: null, updatedBy: null });
        continue;
      }
      out.set(key, {
        state: this.tryOpen(record) === null ? 'undecryptable' : 'set',
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
      });
    }
    return out;
  };
}
