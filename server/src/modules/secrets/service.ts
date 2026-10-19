/**
 * Secrets maintenance at boot (google mode) — AC-39, AC-41, AC-42.
 *
 * Application ring: orchestrates the `SecretStore` + `AuditLog` ports and the
 * pure `secret-box` primitives. Never touches SQL, Fastify or the container;
 * every dependency arrives in the deps object built by the composition root.
 *
 * Secret policy: log lines and audit metadata carry KEY NAMES and counts only —
 * never a value, ciphertext, nonce, key id or master key.
 */
import type { AuditLog, EncryptedSecretRecord, EncryptedSecretWrite, SecretKey, SecretStore } from '@devdigest/shared';
import { aadFor, keyId, open, seal } from '../../platform/crypto/secret-box.js';

/** Structural logger (pino satisfies it); messages are plain strings. */
export interface SecretsLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Legacy env names read for a managed key besides the key's own name
 * (`LocalSecretsProvider` reads `GITHUB_PAT` as a `GITHUB_TOKEN` fallback).
 */
export const LEGACY_ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  GITHUB_TOKEN: ['GITHUB_PAT'],
};

/** Every env var name that maps onto a managed key (own name first, then aliases). */
export function envNamesFor(key: SecretKey): readonly string[] {
  return [key, ...(LEGACY_ENV_ALIASES[key] ?? [])];
}

export interface SecretsMaintenanceDeps<Tx> {
  store: SecretStore<Tx>;
  audit: AuditLog<Tx>;
  /** Current 32-byte master key. Never logged. */
  masterKey: Buffer;
  /** Previous master key for rotation (AC-42), or null. Never logged. */
  previousKey: Buffer | null;
  /** The managed key names (`SECRET_KEY_BY_PROVIDER` values). */
  managedKeys: readonly SecretKey[];
  /** Process env — only NAMES are inspected for the ignored-env warning. */
  env: Readonly<Record<string, string | undefined>>;
  log: SecretsLogger;
}

export interface RotationResult {
  /** Rows now under the current key. */
  reencrypted: number;
  /** Rows tagged with the previous key id that failed to decrypt (left as-is). */
  failedKeyNames: string[];
}

export interface BootCheckResult {
  rotation: RotationResult | null;
  undecryptable: string[];
  ignoredEnv: string[];
}

function tryOpen(record: EncryptedSecretRecord, key: Buffer): string | null {
  try {
    return open(
      { ciphertext: Buffer.from(record.ciphertext), nonce: Buffer.from(record.nonce) },
      key,
      aadFor(record.workspaceId, record.keyName),
    );
  } catch {
    return null;
  }
}

export class SecretsMaintenance<Tx> {
  private readonly currentKeyId: string;

  constructor(private readonly deps: SecretsMaintenanceDeps<Tx>) {
    // Validates the key length (throws without echoing the key).
    this.currentKeyId = keyId(deps.masterKey);
  }

  /** Run every boot check in order. Never throws for an undecryptable secret (AC-41). */
  bootCheck = async (): Promise<BootCheckResult> => {
    const rotation = await this.rotateIfNeeded();
    const undecryptable = await this.reportUndecryptable();
    const ignoredEnv = this.warnIgnoredEnv();
    return { rotation, undecryptable, ignoredEnv };
  };

  /**
   * AC-42: with a previous key configured, re-encrypt every row tagged with the
   * previous key's id under the current key, in ONE transaction, and record one
   * `secrets.reencrypt` audit event per affected workspace inside it. A row
   * under the previous key id that fails authentication cannot be recovered; it
   * is left untouched (reported `undecryptable` afterwards) and named in the log.
   * Returns null when no rotation applies.
   */
  rotateIfNeeded = async (): Promise<RotationResult | null> => {
    const { previousKey, store, audit, masterKey, log } = this.deps;
    if (!previousKey) return null;
    const previousKeyId = keyId(previousKey);
    if (previousKeyId === this.currentKeyId) return null;

    const result = await store.transaction(async (tx) => {
      const rows = (await store.list(undefined, tx)).filter((r) => r.keyId === previousKeyId);
      const failedKeyNames: string[] = [];
      const byWorkspace = new Map<string, string[]>();
      for (const row of rows) {
        const plaintext = tryOpen(row, previousKey);
        if (plaintext === null) {
          failedKeyNames.push(row.keyName);
          continue;
        }
        const sealed = seal(plaintext, masterKey, aadFor(row.workspaceId, row.keyName));
        const write: EncryptedSecretWrite = {
          workspaceId: row.workspaceId,
          keyName: row.keyName,
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
          keyId: this.currentKeyId,
          // Rotation is not an edit: keep who last saved the value.
          updatedBy: row.updatedBy,
        };
        await store.upsert(write, tx);
        const names = byWorkspace.get(row.workspaceId) ?? [];
        names.push(row.keyName);
        byWorkspace.set(row.workspaceId, names);
      }
      for (const [workspaceId, keyNames] of byWorkspace) {
        await audit.record(
          {
            workspaceId,
            actorUserId: null,
            action: 'secrets.reencrypt',
            targetType: 'secret_store',
            targetId: null,
            metadata: { count: keyNames.length, key_names: keyNames },
          },
          tx,
        );
      }
      const reencrypted = [...byWorkspace.values()].reduce((n, names) => n + names.length, 0);
      return { reencrypted, failedKeyNames };
    });

    log.info(`re-encrypted ${result.reencrypted} secrets`);
    if (result.failedKeyNames.length > 0) {
      log.error(
        `could not re-encrypt ${result.failedKeyNames.join(', ')} with the previous master key — ` +
          're-enter them in Settings',
      );
    }
    return result;
  };

  /**
   * AC-41: one error line naming every stored secret (all workspaces) that the
   * current master key cannot decrypt. Names only; returns them (deduplicated).
   */
  reportUndecryptable = async (): Promise<string[]> => {
    const rows = await this.deps.store.list();
    const names = new Set<string>();
    for (const row of rows) {
      const ok = row.keyId === this.currentKeyId && tryOpen(row, this.deps.masterKey) !== null;
      if (!ok) names.add(row.keyName);
    }
    const list = [...names].sort();
    if (list.length > 0) {
      this.deps.log.error(
        `secrets can't be decrypted with the current master key: ${list.join(', ')} — ` +
          're-enter them in Settings (or configure SECRETS_MASTER_KEY_PREVIOUS)',
      );
    }
    return list;
  };

  /**
   * AC-39: one warning per managed-key env var present in the environment —
   * the NAME only. Those variables are ignored in google mode.
   */
  warnIgnoredEnv = (): string[] => {
    const present: string[] = [];
    for (const key of this.deps.managedKeys) {
      for (const name of envNamesFor(key)) {
        const v = this.deps.env[name];
        if (typeof v === 'string' && v.length > 0 && !present.includes(name)) present.push(name);
      }
    }
    for (const name of present) {
      this.deps.log.warn(
        `${name} is set in the environment but ignored in google mode — secrets come only from ` +
          'the encrypted store (import once with `pnpm secrets:import`, then remove it)',
      );
    }
    return present;
  };
}
