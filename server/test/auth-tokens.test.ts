import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  codeChallengeS256,
  codeVerifier,
  newApiToken,
  newSessionId,
  randomToken,
  safeEqual,
  sha256Hex,
} from '../src/platform/crypto/tokens.js';

const B64URL = /^[A-Za-z0-9_-]+$/;

describe('auth tokens', () => {
  it('randomToken defaults to 32 bytes (≥ 256 bits) of base64url', () => {
    const t = randomToken();
    expect(t).toHaveLength(43);
    expect(t).toMatch(B64URL);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(randomToken()).not.toBe(t);
    expect(() => randomToken(0)).toThrow(RangeError);
  });

  it('newSessionId is 256-bit, url-safe and unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newSessionId()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(B64URL);
      expect(Buffer.from(id, 'base64url').length).toBeGreaterThanOrEqual(32);
    }
  });

  it('newApiToken has the ddg_pat_ prefix, 256-bit body and a hash ≠ value', () => {
    const t = newApiToken();
    expect(t.value.startsWith('ddg_pat_')).toBe(true);
    const body = t.value.slice('ddg_pat_'.length);
    expect(body).toHaveLength(43);
    expect(Buffer.from(body, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(t.prefix).toBe(t.value.slice(0, 12));
    expect(t.prefix).toHaveLength(12);
    expect(t.hash).toBe(sha256Hex(t.value));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).not.toContain(body);
    expect(newApiToken().value).not.toBe(t.value);
  });

  it('safeEqual compares in constant time over digests, any length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('PKCE S256 matches RFC 7636 appendix B', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const v = codeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(codeChallengeS256(v)).toBe(createHash('sha256').update(v).digest('base64url'));
  });
});
