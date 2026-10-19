import { describe, it, expect } from 'vitest';
import { gitlabCheckToResult, rowsToSettings } from '../src/modules/settings/helpers.js';

describe('gitlabCheckToResult', () => {
  it('maps every GitLab token-check outcome to the connection-test result (AC-2..AC-5)', () => {
    expect(gitlabCheckToResult({ ok: false, reason: 'expired' })).toEqual({
      ok: false,
      message: 'GitLab token is expired',
    });
    expect(
      gitlabCheckToResult({
        ok: true,
        username: 'dev',
        scopes: ['read_user'],
        missingScopes: ['read_api', 'read_repository'],
      }),
    ).toEqual({ ok: false, message: 'Missing scopes: read_api, read_repository' });
    expect(
      gitlabCheckToResult({ ok: true, username: 'dev', scopes: null, missingScopes: [] }),
    ).toEqual({
      ok: true,
      message: 'Connected as @dev (scope sufficiency is verified on first repo access)',
    });
    expect(
      gitlabCheckToResult({ ok: true, username: 'dev', scopes: ['read_api'], missingScopes: [] }),
    ).toEqual({ ok: true, message: 'Connected as @dev' });
  });
});

describe('rowsToSettings', () => {
  it('collapses key/value rows into a flat object (last row wins)', () => {
    expect(
      rowsToSettings([
        { key: 'theme', value: 'dark' },
        { key: 'theme', value: 'light' },
      ]),
    ).toEqual({ theme: 'light' });
  });
});
