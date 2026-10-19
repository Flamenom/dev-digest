/**
 * Secret store repository — CRUD over `encrypted_secrets` rows.
 *
 * Stores and returns CIPHERTEXT only: encryption/decryption is the adapter's job
 * (`adapters/secrets/encrypted.ts` with `platform/secret-box.ts`). `bytea`
 * columns travel as Node `Buffer`s. Row contents are never logged, and errors
 * raised here never embed ciphertext, nonces or key ids. Workspace-scoped:
 * every read/write is keyed by `(workspace_id, key_name)`.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type {
  EncryptedSecretRecord,
  EncryptedSecretWrite,
  SecretStore,
} from '../../vendor/shared/auth-ports.js';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/** The handle Drizzle passes to a `db.transaction(async (tx) => …)` callback. */
export type SecretsTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** AES-256-GCM nonce length; mirrors the `encrypted_secrets_nonce_len_ck` CHECK. */
const NONCE_BYTES = 12;

type SecretRow = typeof t.encryptedSecrets.$inferSelect;

/** Zero-copy view of a Uint8Array as a Buffer (driver wants Buffer for bytea). */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toRecord(row: SecretRow): EncryptedSecretRecord {
  return {
    workspaceId: row.workspaceId,
    keyName: row.keyName,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    keyId: row.keyId,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** Validate a write before it reaches SQL. Messages name the key only — never bytes. */
function assertWritable(record: EncryptedSecretWrite): void {
  if (!record.keyName) throw new Error('encrypted secret write: key name is required');
  if (!record.keyId) throw new Error(`encrypted secret write for ${record.keyName}: key id is required`);
  if (record.nonce.byteLength !== NONCE_BYTES) {
    throw new Error(`encrypted secret write for ${record.keyName}: nonce must be ${NONCE_BYTES} bytes`);
  }
  if (record.ciphertext.byteLength === 0) {
    throw new Error(`encrypted secret write for ${record.keyName}: ciphertext is empty`);
  }
}

function toValues(record: EncryptedSecretWrite) {
  return {
    workspaceId: record.workspaceId,
    keyName: record.keyName,
    ciphertext: toBuffer(record.ciphertext),
    nonce: toBuffer(record.nonce),
    keyId: record.keyId,
    updatedBy: record.updatedBy,
  };
}

export class SecretStoreRepository implements SecretStore<SecretsTx> {
  constructor(private db: Db) {}

  private exec(tx?: SecretsTx): Db {
    // A transaction exposes the same builders as the client; the cast avoids a
    // `Db | PgTransaction` union TypeScript can't resolve overloads across.
    return (tx ?? this.db) as Db;
  }

  get = async (workspaceId: string, keyName: string, tx?: SecretsTx): Promise<EncryptedSecretRecord | undefined> => {
    const [row] = await this.exec(tx)
      .select()
      .from(t.encryptedSecrets)
      .where(and(eq(t.encryptedSecrets.workspaceId, workspaceId), eq(t.encryptedSecrets.keyName, keyName)))
      .limit(1);
    return row ? toRecord(row) : undefined;
  };

  list = async (workspaceId?: string, tx?: SecretsTx): Promise<EncryptedSecretRecord[]> => {
    const q = this.exec(tx).select().from(t.encryptedSecrets);
    const rows = await (workspaceId ? q.where(eq(t.encryptedSecrets.workspaceId, workspaceId)) : q).orderBy(
      asc(t.encryptedSecrets.workspaceId),
      asc(t.encryptedSecrets.keyName),
    );
    return rows.map(toRecord);
  };

  /** Rows encrypted under `keyId` (rotation scan), optionally limited to one workspace. */
  listByKeyId = async (keyId: string, workspaceId?: string, tx?: SecretsTx): Promise<EncryptedSecretRecord[]> => {
    const byKey = eq(t.encryptedSecrets.keyId, keyId);
    const rows = await this.exec(tx)
      .select()
      .from(t.encryptedSecrets)
      .where(workspaceId ? and(byKey, eq(t.encryptedSecrets.workspaceId, workspaceId)) : byKey)
      .orderBy(asc(t.encryptedSecrets.workspaceId), asc(t.encryptedSecrets.keyName));
    return rows.map(toRecord);
  };

  /** One atomic `INSERT … ON CONFLICT (workspace_id, key_name) DO UPDATE`. */
  upsert = async (record: EncryptedSecretWrite, tx?: SecretsTx): Promise<void> => {
    assertWritable(record);
    const values = toValues(record);
    await this.exec(tx)
      .insert(t.encryptedSecrets)
      .values(values)
      .onConflictDoUpdate({
        target: [t.encryptedSecrets.workspaceId, t.encryptedSecrets.keyName],
        set: {
          ciphertext: values.ciphertext,
          nonce: values.nonce,
          keyId: values.keyId,
          updatedBy: values.updatedBy,
          updatedAt: sql`now()`,
        },
      });
  };

  /** `INSERT … ON CONFLICT DO NOTHING`; true when this call inserted the row. */
  insertIfAbsent = async (record: EncryptedSecretWrite, tx?: SecretsTx): Promise<boolean> => {
    assertWritable(record);
    const inserted = await this.exec(tx)
      .insert(t.encryptedSecrets)
      .values(toValues(record))
      .onConflictDoNothing({ target: [t.encryptedSecrets.workspaceId, t.encryptedSecrets.keyName] })
      .returning({ id: t.encryptedSecrets.id });
    return inserted.length > 0;
  };

  /**
   * Replace many rows all-or-nothing (rotation re-encrypt). Joins `tx` when
   * given; otherwise opens its own transaction so a partial rewrite is impossible.
   */
  replaceMany = async (records: readonly EncryptedSecretWrite[], tx?: SecretsTx): Promise<void> => {
    records.forEach(assertWritable);
    if (!tx) return this.transaction((own) => this.replaceMany(records, own));
    for (const record of records) await this.upsert(record, tx);
  };

  transaction = <T>(fn: (tx: SecretsTx) => Promise<T>): Promise<T> => this.db.transaction(fn);
}
