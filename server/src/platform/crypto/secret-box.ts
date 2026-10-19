/**
 * Authenticated encryption for secrets at rest (AC-36, AC-37).
 *
 * AES-256-GCM, a fresh random 96-bit nonce per `seal`, a 128-bit tag appended
 * to the ciphertext, and associated data that binds the ciphertext to its
 * (workspace, key name) slot — moving a ciphertext onto another key's row makes
 * `open` fail. Pure Node built-ins; no I/O. Errors never carry key material,
 * plaintext or ciphertext.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
export const SECRET_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
const KEY_ID_LABEL = 'devdigest/secret-key-id/v1';
const AAD_LABEL = 'devdigest/secret/v1';

export interface SealedSecret {
  /** Ciphertext with the 16-byte GCM tag appended. */
  ciphertext: Buffer;
  /** The 12-byte random nonce used for this encryption. */
  nonce: Buffer;
}

/** Thrown by `open` for any failure (wrong key, wrong AAD, tampering, bad shape). */
export class SecretBoxError extends Error {
  constructor(message = 'secret could not be decrypted') {
    super(message);
    this.name = 'SecretBoxError';
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== SECRET_KEY_BYTES) {
    // Never echo the key — only its required length.
    throw new SecretBoxError(`secret key must be exactly ${SECRET_KEY_BYTES} bytes`);
  }
}

/** Associated data binding a ciphertext to its workspace + key-name slot. */
export function aadFor(workspaceId: string, keyName: string): Buffer {
  // JSON array encoding is unambiguous (no delimiter-collision between fields).
  return Buffer.from(JSON.stringify([AAD_LABEL, workspaceId, keyName]), 'utf8');
}

export function seal(plaintext: string, key: Buffer, aad: Buffer): SealedSecret {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function open(sealed: SealedSecret, key: Buffer, aad: Buffer): string {
  assertKey(key);
  const { ciphertext, nonce } = sealed;
  if (
    !Buffer.isBuffer(ciphertext) ||
    !Buffer.isBuffer(nonce) ||
    nonce.length !== NONCE_BYTES ||
    ciphertext.length < TAG_BYTES
  ) {
    throw new SecretBoxError();
  }
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // Swallow the OpenSSL error: it adds nothing and must not leak into logs.
    throw new SecretBoxError();
  }
}

/**
 * Non-reversible identifier of a master key (AC-37): HMAC-SHA256 keyed by the
 * master key over a fixed label, first 16 bytes as hex (32 chars). Stable for
 * the same key; reveals nothing usable for decryption.
 */
export function keyId(key: Buffer): string {
  assertKey(key);
  return createHmac('sha256', key).update(KEY_ID_LABEL).digest().subarray(0, 16).toString('hex');
}
