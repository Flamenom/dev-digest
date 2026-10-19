import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/platform/config.js';

/**
 * Hermetic: builds the env from scratch (no process.env spread) so a developer's
 * `.env` cannot influence the outcome. Covers AC-1, AC-3 and the config half of AC-4.
 */
const KEY = randomBytes(32).toString('base64');
const PREV_KEY = randomBytes(32).toString('base64');
const SHORT_KEY = randomBytes(16).toString('base64');
const CLIENT_SECRET = 'GOCSPX-super-secret-value-123';

const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ NODE_ENV: 'test', ...extra }) as NodeJS.ProcessEnv;

const googleEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  base({
    AUTH_MODE: 'google',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    AUTH_ALLOWED_DOMAIN: 'OnlyTraf.com',
    AUTH_ADMIN_EMAILS: ' Alice@onlytraf.com , ,bob@onlytraf.com,alice@ONLYTRAF.com ',
    PUBLIC_HOSTNAME: 'DevDigest.onlytraf.com',
    SECRETS_MASTER_KEY: KEY,
    ...overrides,
  });

function configErrorMessage(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (err) {
    const e = err as { code?: string; message: string; issues?: unknown };
    // A ConfigError (matched by shape), never a raw ZodError that could echo input.
    expect(e.code).toBe('config_error');
    expect(e.issues).toBeUndefined();
    return e.message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('config — auth mode', () => {
  it('defaults to local mode with today’s behaviour when nothing new is set', () => {
    const cfg = loadConfig(base({ WEB_PORT: '3000' }));
    expect(cfg.authMode).toBe('local');
    expect(cfg.webOrigin).toBe('http://localhost:3000');
    expect(cfg.google).toBeNull();
    expect(cfg.publicOrigin).toBeNull();
    expect(cfg.publicApiBase).toBeNull();
    expect(cfg.masterKey).toBeNull();
    expect(cfg.previousMasterKey).toBeNull();
    expect(cfg.adminEmails).toEqual([]);
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.allowUnauthenticatedLocal).toBe(false);
    // Empty values from the .env template behave as unset.
    expect(loadConfig(base({ AUTH_MODE: '', TRUST_PROXY: '', SECRETS_MASTER_KEY: '' })).authMode).toBe(
      'local',
    );
  });

  it('parses a complete google configuration', () => {
    const cfg = loadConfig(
      googleEnv({ SECRETS_MASTER_KEY_PREVIOUS: PREV_KEY, TRUST_PROXY: '172.30.0.10, 10.0.0.0/8' }),
    );
    expect(cfg.authMode).toBe('google');
    expect(cfg.google).toEqual({
      clientId: 'client-id.apps.googleusercontent.com',
      clientSecret: CLIENT_SECRET,
    });
    expect(cfg.allowedDomain).toBe('onlytraf.com');
    expect(cfg.adminEmails).toEqual(['alice@onlytraf.com', 'bob@onlytraf.com']);
    expect(cfg.publicOrigin).toBe('https://devdigest.onlytraf.com');
    expect(cfg.publicApiBase).toBe('https://devdigest.onlytraf.com/api');
    expect(cfg.webOrigin).toBe('https://devdigest.onlytraf.com');
    expect(cfg.masterKey?.equals(Buffer.from(KEY, 'base64'))).toBe(true);
    expect(cfg.masterKey?.length).toBe(32);
    expect(cfg.previousMasterKey?.equals(Buffer.from(PREV_KEY, 'base64'))).toBe(true);
    expect(cfg.trustProxy).toEqual(['172.30.0.10', '10.0.0.0/8']);
    expect(cfg.allowUnauthenticatedLocal).toBe(false);
    // host:port is accepted
    expect(loadConfig(googleEnv({ PUBLIC_HOSTNAME: 'localhost:8443' })).publicOrigin).toBe(
      'https://localhost:8443',
    );
  });

  it('rejects an unknown AUTH_MODE naming the allowed values', () => {
    const msg = configErrorMessage(base({ AUTH_MODE: 'sso' }));
    expect(msg).toContain('AUTH_MODE');
    expect(msg).toContain('local');
    expect(msg).toContain('google');
    expect(msg).not.toContain('sso');
  });

  it('names a 16-byte master key without echoing it', () => {
    const msg = configErrorMessage(googleEnv({ SECRETS_MASTER_KEY: SHORT_KEY }));
    expect(msg).toContain('SECRETS_MASTER_KEY');
    expect(msg).toContain('32 bytes');
    expect(msg).not.toContain(SHORT_KEY);
    expect(msg).not.toContain('PUBLIC_HOSTNAME');
    expect(msg).not.toContain('GOOGLE_CLIENT_ID');
    // non-base64 garbage is rejected too
    expect(configErrorMessage(googleEnv({ SECRETS_MASTER_KEY: `${KEY.slice(0, -1)}!` }))).toContain(
      'SECRETS_MASTER_KEY',
    );
  });

  it('names an http:// PUBLIC_HOSTNAME without echoing it', () => {
    for (const bad of ['http://x', 'https://devdigest.onlytraf.com', 'host/path', 'user@host', 'a b']) {
      const msg = configErrorMessage(googleEnv({ PUBLIC_HOSTNAME: bad }));
      expect(msg).toContain('PUBLIC_HOSTNAME');
      expect(msg).not.toContain(bad);
      expect(msg).not.toContain('SECRETS_MASTER_KEY');
    }
  });

  it('names a missing client id', () => {
    const env = googleEnv();
    delete env.GOOGLE_CLIENT_ID;
    const msg = configErrorMessage(env);
    expect(msg).toContain('GOOGLE_CLIENT_ID');
    expect(msg).not.toContain('GOOGLE_CLIENT_SECRET');
    expect(msg).not.toContain(CLIENT_SECRET);
    expect(msg).not.toContain(KEY);
  });

  it('collects every offending setting in one error', () => {
    const msg = configErrorMessage(
      base({ AUTH_MODE: 'google', SECRETS_MASTER_KEY: SHORT_KEY, PUBLIC_HOSTNAME: 'http://x' }),
    );
    for (const name of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'AUTH_ALLOWED_DOMAIN',
      'PUBLIC_HOSTNAME',
      'SECRETS_MASTER_KEY',
    ]) {
      expect(msg).toContain(name);
    }
    expect(msg).not.toContain(SHORT_KEY);
    expect(msg).not.toContain('http://x');
  });

  it('rejects an invalid previous master key, admin list and trust-proxy list', () => {
    const msg = configErrorMessage(
      googleEnv({
        SECRETS_MASTER_KEY_PREVIOUS: SHORT_KEY,
        AUTH_ADMIN_EMAILS: 'not-an-email',
        TRUST_PROXY: 'caddy',
      }),
    );
    expect(msg).toContain('SECRETS_MASTER_KEY_PREVIOUS');
    expect(msg).toContain('AUTH_ADMIN_EMAILS');
    expect(msg).toContain('TRUST_PROXY');
    expect(msg).not.toContain(SHORT_KEY);
    expect(msg).not.toContain('not-an-email');
  });

  it('refuses local mode in production unless acknowledged', () => {
    const msg = configErrorMessage(base({ NODE_ENV: 'production' }));
    expect(msg).toContain('AUTH_MODE=google');
    expect(msg).toContain('ALLOW_UNAUTHENTICATED_LOCAL_MODE');

    expect(configErrorMessage(base({ NODE_ENV: 'production', ALLOW_UNAUTHENTICATED_LOCAL_MODE: 'yes' }))).toContain(
      'ALLOW_UNAUTHENTICATED_LOCAL_MODE',
    );

    const cfg = loadConfig(base({ NODE_ENV: 'production', ALLOW_UNAUTHENTICATED_LOCAL_MODE: 'true' }));
    expect(cfg.authMode).toBe('local');
    expect(cfg.allowUnauthenticatedLocal).toBe(true);

    // google mode in production needs no acknowledgement
    expect(loadConfig(googleEnv({ NODE_ENV: 'production' })).authMode).toBe('google');
  });
});
