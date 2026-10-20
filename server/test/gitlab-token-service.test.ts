import { describe, it, expect, vi } from 'vitest';
import type { GitLabScopeCheck } from '../src/vendor/shared/index.js';
import { GitLabTokenHealthService } from '../src/modules/settings/gitlab-token-health.js';
import { GitLabTokenService } from '../src/modules/settings/gitlab-token-service.js';

const SPEC_SCOPE_MSG = 'This token is missing the api scope. Required scope: api (Reporter role recommended).';
const ADMIN = { workspaceId: 'w-1', userId: 'admin-1', audit: null };

function setup(probeResult: GitLabScopeCheck, stored: string | null = 'glpat-old') {
  let token = stored;
  const probe = vi.fn(async (_t: string) => probeResult);
  const saveToken = vi.fn(async (t: string, _actor: typeof ADMIN) => {
    token = t;
  });
  const invalidateCaches = vi.fn();
  const health = new GitLabTokenHealthService({ readToken: async () => token, check: probe });
  const svc = new GitLabTokenService<typeof ADMIN>({
    probe,
    readToken: async () => token,
    saveToken,
    invalidateCaches,
    health,
  });
  return { svc, probe, saveToken, invalidateCaches, health, stored: () => token };
}

describe('GitLabTokenService.save', () => {
  it('insufficient_scope → ok:false with the spec code+message; nothing stored, previous token kept (AC-21)', async () => {
    const t = setup({ kind: 'insufficient_scope', username: 'bot' });
    const res = await t.svc.save('glpat-read', ADMIN);
    expect(res).toEqual({ ok: false, code: 'gitlab_token_insufficient_scope', message: SPEC_SCOPE_MSG });
    expect(t.probe).toHaveBeenCalledWith('glpat-read');
    expect(t.saveToken).not.toHaveBeenCalled();
    expect(t.invalidateCaches).not.toHaveBeenCalled();
    expect(t.stored()).toBe('glpat-old');
  });

  it('ok → stored once (with the actor), caches dropped, Connected as @bot, health ok (AC-22, AC-24)', async () => {
    const t = setup({ kind: 'ok', username: 'bot', scopes: ['api'] });
    const res = await t.svc.save('glpat-api', ADMIN);
    expect(res).toEqual({ ok: true, message: 'Connected as @bot' });
    expect(t.saveToken).toHaveBeenCalledTimes(1);
    expect(t.saveToken).toHaveBeenCalledWith('glpat-api', ADMIN);
    expect(t.invalidateCaches).toHaveBeenCalledTimes(1);
    await expect(t.health.current()).resolves.toBe('ok');
    // health was recorded on save → no further lookup on first use
    await t.health.ensureUsable();
    expect(t.probe).toHaveBeenCalledTimes(1);
  });

  it('unverified → not stored, gitlab_token_unverified (AC-28)', async () => {
    const t = setup({ kind: 'unverified' });
    const res = await t.svc.save('glpat-x', ADMIN);
    expect(res).toEqual({
      ok: false,
      code: 'gitlab_token_unverified',
      message: "Couldn't verify the token's scopes — try again",
    });
    expect(t.saveToken).not.toHaveBeenCalled();
  });

  it('invalid → not stored, gitlab_token_invalid', async () => {
    const t = setup({ kind: 'invalid', reason: 'expired' });
    const res = await t.svc.save('glpat-x', ADMIN);
    expect(res).toEqual({ ok: false, code: 'gitlab_token_invalid', message: 'GitLab token is expired' });
    expect(t.saveToken).not.toHaveBeenCalled();
  });

  it('a failing save propagates and the token is not recorded healthy', async () => {
    const t = setup({ kind: 'ok', username: 'bot', scopes: ['api'] });
    t.saveToken.mockRejectedValueOnce(new Error('db down'));
    await expect(t.svc.save('glpat-api', ADMIN)).rejects.toThrow('db down');
    expect(t.invalidateCaches).not.toHaveBeenCalled();
  });

  it('no result message contains the key', async () => {
    const key = 'glpat-SUPERSECRET';
    const checks: GitLabScopeCheck[] = [
      { kind: 'ok', username: 'bot', scopes: ['api'] },
      { kind: 'insufficient_scope', username: null },
      { kind: 'unverified' },
      { kind: 'invalid', reason: 'revoked' },
    ];
    for (const c of checks) {
      const res = await setup(c).svc.save(key, ADMIN);
      expect(JSON.stringify(res)).not.toContain(key);
    }
  });
});

describe('GitLabTokenService.testStored', () => {
  it('no stored token → gitlab_token_missing, 0 probes', async () => {
    const t = setup({ kind: 'ok', username: 'bot', scopes: ['api'] }, null);
    await expect(t.svc.testStored()).resolves.toEqual({
      ok: false,
      code: 'gitlab_token_missing',
      message: 'No GitLab token is configured.',
    });
    expect(t.probe).not.toHaveBeenCalled();
  });

  it('stored legacy token → insufficient_scope result and the stored token health becomes insufficient_scope', async () => {
    const t = setup({ kind: 'insufficient_scope', username: 'bot' });
    await expect(t.svc.testStored()).resolves.toMatchObject({ ok: false, code: 'gitlab_token_insufficient_scope' });
    expect(t.saveToken).not.toHaveBeenCalled();
    await expect(t.health.current()).resolves.toBe('insufficient_scope');
  });

  it('stored api token → Connected as @bot and health ok', async () => {
    const t = setup({ kind: 'ok', username: 'bot', scopes: ['api', 'read_user'] });
    await expect(t.svc.testStored()).resolves.toEqual({ ok: true, message: 'Connected as @bot' });
    await expect(t.health.current()).resolves.toBe('ok');
  });

  it('transient failure on a stored token keeps health unchecked (AC-28)', async () => {
    const t = setup({ kind: 'unverified' });
    await expect(t.svc.testStored()).resolves.toMatchObject({ code: 'gitlab_token_unverified' });
    await expect(t.health.current()).resolves.toBe('unchecked');
  });
});
