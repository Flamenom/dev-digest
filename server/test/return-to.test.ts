import { describe, it, expect } from 'vitest';
import { safeReturnTo } from '../src/platform/auth/return-to.js';

describe('safeReturnTo (AC-16)', () => {
  it.each([
    'https://evil.io',
    'http://evil.io/path',
    '//evil.io',
    '/\\evil.io',
    '\\evil.io',
    '\\\\evil.io',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '%2F%2Fevil.io',
    '/%2F%2Fevil.io',
    '/%2fevil.io',
    '/%5Cevil.io',
    '/%5cevil.io',
    '/\t/evil.io',
    '/\n/evil.io',
    '/%09/evil.io',
    '/%0a/evil.io',
    '/%E0%A4%A', // malformed escape
    'repos/x',
    ' /repos/x',
    '',
    '/' + 'a'.repeat(5000),
  ])('rejects %j → /', (raw) => {
    expect(safeReturnTo(raw)).toBe('/');
  });

  it.each([undefined, null, 42, {}, ['/repos']])('rejects non-string %j → /', (raw) => {
    expect(safeReturnTo(raw)).toBe('/');
  });

  it.each(['/', '/repos/x/pulls?y=1', '/repos/x/pulls/12#files', '/settings?tab=api%20keys'])(
    'keeps same-origin path %j',
    (raw) => {
      expect(safeReturnTo(raw)).toBe(raw);
    },
  );
});
