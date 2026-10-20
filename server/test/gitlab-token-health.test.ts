import { describe, it, expect, vi } from 'vitest';
import type { GitLabScopeCheck } from '../src/vendor/shared/index.js';
import {
  GITLAB_INSUFFICIENT_SCOPE_MESSAGE,
  GitLabTokenHealthService,
} from '../src/modules/settings/gitlab-token-health.js';

const OK: GitLabScopeCheck = { kind: 'ok', username: 'devdigest-bot', scopes: ['api'] };
const LEGACY: GitLabScopeCheck = { kind: 'insufficient_scope', username: 'devdigest-bot' };

function setup(initialToken: string | null, checks: GitLabScopeCheck[] | ((t: string) => Promise<GitLabScopeCheck>)) {
  let token = initialToken;
  const queue = Array.isArray(checks) ? [...checks] : null;
  const check = vi.fn(
    Array.isArray(checks)
      ? async () => queue!.shift() ?? OK
      : checks,
  );
  const svc = new GitLabTokenHealthService({ readToken: async () => token, check });
  return { svc, check, setToken: (t: string | null) => (token = t) };
}

describe('GitLabTokenHealthService', () => {
  it('no token → ensureUsable null and current() null, with 0 checks (AC-29, Q2)', async () => {
    const { svc, check } = setup(null, []);
    await expect(svc.ensureUsable()).resolves.toBeNull();
    await expect(svc.current()).resolves.toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('legacy read_api token: first use checks once and blocks; later uses block with 0 further checks (AC-23/24)', async () => {
    const { svc, check } = setup('glpat-legacy', [LEGACY]);
    await expect(svc.current()).resolves.toBe('unchecked');
    const err1 = await svc.ensureUsable().catch((e) => e);
    expect(err1).toMatchObject({
      code: 'gitlab_token_insufficient_scope',
      statusCode: 400,
      message: GITLAB_INSUFFICIENT_SCOPE_MESSAGE,
    });
    expect(check).toHaveBeenCalledTimes(1);
    await expect(svc.ensureUsable()).rejects.toMatchObject({ code: 'gitlab_token_insufficient_scope' });
    expect(check).toHaveBeenCalledTimes(1);
    await expect(svc.current()).resolves.toBe('insufficient_scope');
  });

  it('ok token is memoised and returns the service-account username', async () => {
    const { svc, check } = setup('glpat-api', [OK]);
    await expect(svc.ensureUsable()).resolves.toEqual({ token: 'glpat-api', username: 'devdigest-bot' });
    await expect(svc.ensureUsable()).resolves.toEqual({ token: 'glpat-api', username: 'devdigest-bot' });
    expect(check).toHaveBeenCalledTimes(1);
    await expect(svc.current()).resolves.toBe('ok');
  });

  it('changing the token value resets health to unchecked and re-checks once (AC-24)', async () => {
    const { svc, check, setToken } = setup('glpat-a', [LEGACY, OK]);
    await expect(svc.ensureUsable()).rejects.toBeDefined();
    setToken('glpat-b');
    await expect(svc.current()).resolves.toBe('unchecked');
    await expect(svc.ensureUsable()).resolves.toMatchObject({ token: 'glpat-b' });
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith('glpat-b');
  });

  it('3 concurrent first uses share 1 scope check (single-flight)', async () => {
    let release!: (c: GitLabScopeCheck) => void;
    const { svc, check } = setup('glpat-api', () => new Promise<GitLabScopeCheck>((r) => (release = r)));
    const all = Promise.all([svc.ensureUsable(), svc.ensureUsable(), svc.ensureUsable()]);
    await new Promise((r) => setImmediate(r));
    release(OK);
    const results = await all;
    expect(check).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.username === 'devdigest-bot')).toBe(true);
  });

  it('unverified → gitlab_token_unverified 503, health stays unchecked, next use retries (AC-28)', async () => {
    const { svc, check } = setup('glpat-api', [{ kind: 'unverified' }, OK]);
    await expect(svc.ensureUsable()).rejects.toMatchObject({
      code: 'gitlab_token_unverified',
      statusCode: 503,
      message: "Couldn't verify the token's scopes — try again",
    });
    await expect(svc.current()).resolves.toBe('unchecked');
    await expect(svc.ensureUsable()).resolves.toMatchObject({ username: 'devdigest-bot' });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('a throwing scope lookup is treated as unverified and does not wedge the single-flight slot', async () => {
    let n = 0;
    const { svc, check } = setup('glpat-api', async () => {
      n += 1;
      if (n === 1) throw new Error('boom glpat-api');
      return OK;
    });
    const err = await svc.ensureUsable().catch((e) => e);
    expect(err).toMatchObject({ code: 'gitlab_token_unverified' });
    expect(String(err.message)).not.toContain('glpat-api');
    await expect(svc.ensureUsable()).resolves.toMatchObject({ username: 'devdigest-bot' });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('invalid check → gitlab_token_invalid and health invalid', async () => {
    const { svc } = setup('glpat-dead', [{ kind: 'invalid', reason: 'revoked' }]);
    await expect(svc.ensureUsable()).rejects.toMatchObject({ code: 'gitlab_token_invalid', statusCode: 400 });
    await expect(svc.current()).resolves.toBe('invalid');
  });

  it("reportAuthFailure('invalid') → current() invalid; the next ensureUsable re-checks once (AC-24/29, Q7)", async () => {
    const { svc, check } = setup('glpat-api', [OK, OK]);
    await svc.ensureUsable();
    svc.reportAuthFailure('glpat-api', 'invalid');
    await expect(svc.current()).resolves.toBe('invalid');
    await expect(svc.ensureUsable()).resolves.toMatchObject({ username: 'devdigest-bot' });
    expect(check).toHaveBeenCalledTimes(2);
    await svc.ensureUsable();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("reportAuthFailure('insufficient_scope') → unchecked; the next use re-checks and blocks on a downgrade (AC-24)", async () => {
    const { svc, check } = setup('glpat-api', [OK, LEGACY]);
    await svc.ensureUsable();
    svc.reportAuthFailure('glpat-api', 'insufficient_scope');
    await expect(svc.current()).resolves.toBe('unchecked');
    await expect(svc.ensureUsable()).rejects.toMatchObject({ code: 'gitlab_token_insufficient_scope' });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('record() on save makes the token ok without a further lookup', async () => {
    const { svc, check } = setup('glpat-new', []);
    svc.record('glpat-new', OK);
    await expect(svc.current()).resolves.toBe('ok');
    await expect(svc.ensureUsable()).resolves.toEqual({ token: 'glpat-new', username: 'devdigest-bot' });
    expect(check).not.toHaveBeenCalled();
  });

  it('never exposes the token or its fingerprint through errors', async () => {
    const { svc } = setup('glpat-secret-123', [LEGACY]);
    const err = await svc.ensureUsable().catch((e) => e);
    const dump = JSON.stringify({ message: err.message, code: err.code, details: err.details });
    expect(dump).not.toContain('glpat-secret-123');
    expect(dump).not.toMatch(/[0-9a-f]{64}/);
  });
});
