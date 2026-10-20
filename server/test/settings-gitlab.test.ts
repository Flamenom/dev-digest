import { describe, it, expect } from 'vitest';
import type { GitLabScopeCheck, SecretKey, SecretsProvider } from '@devdigest/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockAuthProvider, MockGitLabClient } from '../src/adapters/mocks.js';
import { SecretsStatusWithHealth } from '../src/vendor/shared/index.js';

/**
 * GitLab token status + save/test, hermetic: `MockGitLabClient` (scope check)
 * + an in-memory writable SecretsProvider, no DB.
 *
 * Since spec 2026-10-20 (GitLab comment posting) the `api` scope is mandatory:
 * a key is probed BEFORE it is stored and saved only when it carries `api`
 * (AC-21/22/28); secrets-status adds `gitlab_health` (AC-26).
 */
const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const SCOPE_MESSAGE =
  'This token is missing the api scope. Required scope: api (Reporter role recommended).';

class MemorySecrets implements SecretsProvider {
  readonly values = new Map<string, string>();
  async get(key: SecretKey): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: SecretKey, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

async function makeApp(opts: { scopeCheck?: GitLabScopeCheck; secrets?: MemorySecrets } = {}) {
  const secrets = opts.secrets ?? new MemorySecrets();
  const gitlab = new MockGitLabClient({ scopeCheck: opts.scopeCheck });
  const app = await buildApp({
    config,
    overrides: { secrets, gitlab, auth: new MockAuthProvider() },
  });
  return { app, secrets, gitlab };
}

async function testConnection(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: Record<string, unknown>,
) {
  return app.inject({ method: 'POST', url: '/settings/test-connection', payload });
}

async function secretsStatus(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({ method: 'GET', url: '/settings/secrets-status' });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

describe('settings — GitLab token', () => {
  it('stores the GitLab token independently of GitHub; a second save replaces the first (AC-1)', async () => {
    const { app, secrets } = await makeApp();

    const unset = { state: 'unset', updated_at: null, updated_by: null };
    expect(await secretsStatus(app)).toEqual({
      openai: false,
      anthropic: false,
      openrouter: false,
      github: false,
      gitlab: false,
      // Additive per-provider detail (multi-user AC-38); local mode has no who/when.
      states: { openai: unset, anthropic: unset, openrouter: unset, github: unset, gitlab: unset },
      // No GitLab token configured (plan Q2).
      gitlab_health: null,
    });

    await testConnection(app, { provider: 'gitlab', key: 'glpat-first-token' });
    let status = await secretsStatus(app);
    expect(status.gitlab).toBe(true);
    expect(status.github).toBe(false);
    expect(status.gitlab_health).toBe('ok');

    await testConnection(app, { provider: 'gitlab', key: 'glpat-second-token' });
    expect(secrets.values.get('GITLAB_TOKEN')).toBe('glpat-second-token');
    expect(secrets.values.has('GITHUB_TOKEN')).toBe(false);

    // Vice versa: saving a GitHub key leaves the GitLab token untouched.
    await secrets.set('GITHUB_TOKEN', 'ghp-token');
    status = await secretsStatus(app);
    expect(status.github).toBe(true);
    expect(status.gitlab).toBe(true);
    expect(secrets.values.get('GITLAB_TOKEN')).toBe('glpat-second-token');

    await app.close();
  });

  it('`api` token → stored, ok with the username, health ok (AC-22), key never echoed', async () => {
    const { app, gitlab, secrets } = await makeApp({
      scopeCheck: { kind: 'ok', username: 'gl-user', scopes: ['api', 'read_repository'] },
    });
    const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-secret-123' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'gitlab', ok: true, message: 'Connected as @gl-user' });
    expect(res.payload).not.toContain('glpat-secret-123');
    expect(secrets.values.get('GITLAB_TOKEN')).toBe('glpat-secret-123');
    expect(gitlab.callsOf('user')).toHaveLength(1);
    const status = await secretsStatus(app);
    expect(status.gitlab_health).toBe('ok');
    // The response schema is the health-extended one and carries nothing token-derived.
    expect(SecretsStatusWithHealth.safeParse(status).success).toBe(true);
    expect(JSON.stringify(status)).not.toContain('glpat-secret-123');
    await app.close();
  });

  it('token without `api` → ok:false + code + spec message; not stored, previous token kept (AC-21)', async () => {
    const secrets = new MemorySecrets();
    await secrets.set('GITLAB_TOKEN', 'glpat-previous');
    const { app } = await makeApp({
      secrets,
      scopeCheck: { kind: 'insufficient_scope', username: 'gl-user' },
    });
    const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-read-only' });
    expect(res.json()).toEqual({
      provider: 'gitlab',
      ok: false,
      code: 'gitlab_token_insufficient_scope',
      message: SCOPE_MESSAGE,
    });
    expect(res.payload).not.toContain('glpat-read-only');
    expect(secrets.values.get('GITLAB_TOKEN')).toBe('glpat-previous');

    // Test-only (no key) → the same result for the stored token, now remembered (AC-24/26).
    const tested = await testConnection(app, { provider: 'gitlab' });
    expect(tested.json()).toMatchObject({ ok: false, code: 'gitlab_token_insufficient_scope' });
    expect((await secretsStatus(app)).gitlab_health).toBe('insufficient_scope');
    await app.close();
  });

  it.each(['invalid', 'expired', 'revoked'] as const)(
    'rejected token (%s) → ok:false gitlab_token_invalid naming the failure, not stored (AC-29)',
    async (reason) => {
      const { app, secrets } = await makeApp({ scopeCheck: { kind: 'invalid', reason } });
      const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-bad-token-xyz' });
      const body = res.json();
      expect(body.provider).toBe('gitlab');
      expect(body.ok).toBe(false);
      expect(body.code).toBe('gitlab_token_invalid');
      expect(body.message).toContain(reason);
      expect(res.payload).not.toContain('glpat-bad-token-xyz');
      expect(secrets.values.has('GITLAB_TOKEN')).toBe(false);
      await app.close();
    },
  );

  it('scopes not determinable → ok:false gitlab_token_unverified, not stored (AC-28)', async () => {
    const { app, secrets } = await makeApp({ scopeCheck: { kind: 'unverified' } });
    const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-flaky' });
    expect(res.json()).toEqual({
      provider: 'gitlab',
      ok: false,
      code: 'gitlab_token_unverified',
      message: "Couldn't verify the token's scopes — try again",
    });
    expect(secrets.values.has('GITLAB_TOKEN')).toBe(false);
    await app.close();
  });

  it('no key and no stored token → gitlab_token_missing', async () => {
    const { app, gitlab } = await makeApp();
    const res = await testConnection(app, { provider: 'gitlab' });
    expect(res.json()).toEqual({
      provider: 'gitlab',
      ok: false,
      code: 'gitlab_token_missing',
      message: 'No GitLab token is configured.',
    });
    expect(gitlab.calls).toEqual([]);
    await app.close();
  });

  it('a thrown error is redacted before it reaches the response (no token echo)', async () => {
    const secrets = new MemorySecrets();
    const { app, gitlab } = await makeApp({ secrets });
    gitlab.checkTokenScopes = async () => {
      throw new Error('upstream failed for PRIVATE-TOKEN glpat-leaky-token');
    };
    const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-leaky-token' });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(res.payload).not.toContain('glpat-leaky-token');
    expect(body.message).toContain('***');
    expect(secrets.values.has('GITLAB_TOKEN')).toBe(false);
    await app.close();
  });
});
