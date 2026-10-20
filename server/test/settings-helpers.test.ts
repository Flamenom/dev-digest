import { describe, it, expect } from 'vitest';
import { SecretsStatusDetailed } from '../src/vendor/shared/index.js';
import { gitlabCheckToResult, rowsToSettings, toSecretsStatusDto } from '../src/modules/settings/helpers.js';

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

describe('toSecretsStatusDto (G1: built per provider, no cast)', () => {
  it('maps every provider (booleans true only for `set`), defaults a missing one to unset, parses strictly', () => {
    const at = new Date('2026-10-20T10:00:00.000Z');
    const dto = toSecretsStatusDto([
      { provider: 'openai', state: 'set', updatedAt: at, updatedBy: 'u-1', updated_by: { user_id: 'u-1', name: 'Ada' } },
      { provider: 'github', state: 'undecryptable', updatedAt: at, updatedBy: null, updated_by: null },
      { provider: 'gitlab', state: 'unset', updatedAt: null, updatedBy: null, updated_by: null },
      // anthropic + openrouter absent from the input
    ]);
    expect(SecretsStatusDetailed.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({ openai: true, anthropic: false, openrouter: false, github: false, gitlab: false });
    expect(dto.states.openai).toEqual({
      state: 'set',
      updated_at: '2026-10-20T10:00:00.000Z',
      updated_by: { user_id: 'u-1', name: 'Ada' },
    });
    expect(dto.states.github.state).toBe('undecryptable');
    expect(dto.states.anthropic).toEqual({ state: 'unset', updated_at: null, updated_by: null });
    expect(Object.keys(dto.states).sort()).toEqual(['anthropic', 'github', 'gitlab', 'openai', 'openrouter']);
  });
});
