import { describe, it, expect } from 'vitest';
import { SecretsStatusDetailed, SecretsStatusWithHealth } from '../src/vendor/shared/index.js';
import {
  rowsToSettings,
  toSecretsStatusDto,
  toSecretsStatusWithHealth,
} from '../src/modules/settings/helpers.js';

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

describe('toSecretsStatusWithHealth (AC-26, Q2)', () => {
  const entries = [
    {
      provider: 'gitlab' as const,
      state: 'set' as const,
      updatedAt: new Date('2026-10-20T10:00:00.000Z'),
      updatedBy: null,
      updated_by: null,
    },
  ];

  it('adds only the gitlab_health enum on top of the detailed DTO; parses strictly', () => {
    for (const health of ['ok', 'insufficient_scope', 'invalid', 'unchecked'] as const) {
      const dto = toSecretsStatusWithHealth(entries, health);
      expect(SecretsStatusWithHealth.strict().parse(dto)).toEqual(dto);
      expect(dto.gitlab_health).toBe(health);
      expect(dto).toEqual({ ...toSecretsStatusDto(entries), gitlab_health: health });
    }
  });

  it('null health (no GitLab token) is reported as null', () => {
    const dto = toSecretsStatusWithHealth([], null);
    expect(dto.gitlab_health).toBeNull();
    expect(dto.gitlab).toBe(false);
    expect(SecretsStatusWithHealth.parse(dto)).toEqual(dto);
  });
});
