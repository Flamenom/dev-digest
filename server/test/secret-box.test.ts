import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  aadFor,
  keyId,
  open,
  seal,
  SecretBoxError,
  NONCE_BYTES,
  TAG_BYTES,
} from '../src/platform/crypto/secret-box.js';

const key = randomBytes(32);
const aad = aadFor('ws-1', 'GITHUB_TOKEN');
const secret = 'ghp_supersecretvalue1234567890';

describe('secret-box (AES-256-GCM)', () => {
  it('round-trips and never stores plaintext in the ciphertext', () => {
    const sealed = seal(secret, key, aad);
    expect(sealed.nonce).toHaveLength(NONCE_BYTES);
    expect(sealed.ciphertext.length).toBe(Buffer.byteLength(secret) + TAG_BYTES);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('supersecret');
    expect(open(sealed, key, aad)).toBe(secret);
  });

  it('uses a fresh nonce (and ciphertext) on every call', () => {
    const nonces = new Set<string>();
    const cts = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const s = seal(secret, key, aad);
      nonces.add(s.nonce.toString('hex'));
      cts.add(s.ciphertext.toString('hex'));
    }
    expect(nonces.size).toBe(50);
    expect(cts.size).toBe(50);
  });

  it('rejects an AAD swap (other key name or workspace)', () => {
    const sealed = seal(secret, key, aad);
    expect(() => open(sealed, key, aadFor('ws-1', 'GITLAB_TOKEN'))).toThrow(SecretBoxError);
    expect(() => open(sealed, key, aadFor('ws-2', 'GITHUB_TOKEN'))).toThrow(SecretBoxError);
  });

  it('rejects tampered ciphertext, tag or nonce', () => {
    const sealed = seal(secret, key, aad);
    for (const idx of [0, sealed.ciphertext.length - 1]) {
      const ct = Buffer.from(sealed.ciphertext);
      ct[idx] = ct[idx]! ^ 0x01;
      expect(() => open({ ciphertext: ct, nonce: sealed.nonce }, key, aad)).toThrow(SecretBoxError);
    }
    const nonce = Buffer.from(sealed.nonce);
    nonce[0] = nonce[0]! ^ 0x01;
    expect(() => open({ ciphertext: sealed.ciphertext, nonce }, key, aad)).toThrow(SecretBoxError);
    expect(() => open({ ciphertext: Buffer.alloc(4), nonce: sealed.nonce }, key, aad)).toThrow(
      SecretBoxError,
    );
  });

  it('rejects the wrong key without leaking key material in the error', () => {
    const sealed = seal(secret, key, aad);
    const other = randomBytes(32);
    let err: unknown;
    try {
      open(sealed, other, aad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretBoxError);
    const msg = String((err as Error).message);
    expect(msg).not.toContain(other.toString('hex'));
    expect(msg).not.toContain(other.toString('base64'));
  });

  it('requires a 32-byte key', () => {
    expect(() => seal(secret, randomBytes(16), aad)).toThrow(/32 bytes/);
    expect(() => keyId(randomBytes(31))).toThrow(SecretBoxError);
  });

  it('keyId is stable, distinct per key, and not the key bytes', () => {
    const id = keyId(key);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(keyId(Buffer.from(key))).toBe(id);
    expect(keyId(randomBytes(32))).not.toBe(id);
    expect(key.toString('hex')).not.toContain(id);
    expect(id).not.toBe(key.toString('hex').slice(0, 32));
  });

  it('aadFor is unambiguous across field boundaries', () => {
    expect(aadFor('a', 'bc').equals(aadFor('ab', 'c'))).toBe(false);
  });
});
