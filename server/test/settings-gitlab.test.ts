import { describe, it, expect } from 'vitest';
import type { GitLabTokenCheck, SecretKey, SecretsProvider } from '@devdigest/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockAuthProvider, MockGitLabClient } from '../src/adapters/mocks.js';

/**
 * T13 — GitLab token status + connection test (AC-1..AC-5), hermetic:
 * `MockGitLabClient` + an in-memory writable SecretsProvider, no DB.
 */
const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

class MemorySecrets implements SecretsProvider {
  readonly values = new Map<string, string>();
  async get(key: SecretKey): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: SecretKey, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

async function makeApp(opts: { tokenCheck?: GitLabTokenCheck; secrets?: MemorySecrets } = {}) {
  const secrets = opts.secrets ?? new MemorySecrets();
  const gitlab = new MockGitLabClient({ tokenCheck: opts.tokenCheck });
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
  return res.json() as Record<string, boolean>;
}

describe('settings — GitLab token (T13)', () => {
  it('stores the GitLab token independently of GitHub; a second save replaces the first (AC-1)', async () => {
    const { app, secrets } = await makeApp();

    expect(await secretsStatus(app)).toEqual({
      openai: false,
      anthropic: false,
      openrouter: false,
      github: false,
      gitlab: false,
    });

    await testConnection(app, { provider: 'gitlab', key: 'glpat-first-token' });
    let status = await secretsStatus(app);
    expect(status.gitlab).toBe(true);
    expect(status.github).toBe(false);

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

  it('valid token → ok with the username (AC-2), key never echoed', async () => {
    const { app, gitlab } = await makeApp({
      tokenCheck: {
        ok: true,
        username: 'gl-user',
        scopes: ['read_api', 'read_repository'],
        missingScopes: [],
      },
    });
    const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-secret-123' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'gitlab', ok: true, message: 'Connected as @gl-user' });
    expect(res.payload).not.toContain('glpat-secret-123');
    expect(gitlab.callsOf('user')).toHaveLength(1);
    await app.close();
  });

  it.each(['invalid', 'expired', 'revoked'] as const)(
    'rejected token (%s) → ok:false naming the failure, no token in body (AC-3)',
    async (reason) => {
      const { app } = await makeApp({ tokenCheck: { ok: false, reason } });
      const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-bad-token-xyz' });
      const body = res.json();
      expect(body.provider).toBe('gitlab');
      expect(body.ok).toBe(false);
      expect(body.message).toContain(reason);
      expect(res.payload).not.toContain('glpat-bad-token-xyz');
      await app.close();
    },
  );

  it('valid token lacking read scopes → ok:false listing them (AC-4)', async () => {
    const { app } = await makeApp({
      tokenCheck: {
        ok: true,
        username: 'gl-user',
        scopes: ['read_user'],
        missingScopes: ['read_api', 'read_repository'],
      },
    });
    const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-narrow' });
    expect(res.json()).toEqual({
      provider: 'gitlab',
      ok: false,
      message: 'Missing scopes: read_api, read_repository',
    });
    expect(res.payload).not.toContain('glpat-narrow');
    await app.close();
  });

  it('scopes not introspectable → ok:true with a scope-unverified warning (AC-5)', async () => {
    const { app } = await makeApp({
      tokenCheck: { ok: true, username: 'gl-user', scopes: null, missingScopes: [] },
    });
    const res = await testConnection(app, { provider: 'gitlab' });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain('Connected as @gl-user');
    expect(body.message).toContain('scope sufficiency is verified on first repo access');
    await app.close();
  });

  it('a thrown error is redacted before it reaches the response (no token echo)', async () => {
    const secrets = new MemorySecrets();
    const { app, gitlab } = await makeApp({ secrets });
    gitlab.checkToken = async () => {
      throw new Error('upstream failed for PRIVATE-TOKEN glpat-leaky-token');
    };
    const res = await testConnection(app, { provider: 'gitlab', key: 'glpat-leaky-token' });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(res.payload).not.toContain('glpat-leaky-token');
    expect(body.message).toContain('***');
    await app.close();
  });
});
