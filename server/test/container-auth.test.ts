import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AuditEventInput,
  AuditLog,
  Clock,
  EncryptedSecretRecord,
  EncryptedSecretWrite,
  PrincipalProvider,
  SecretStore,
} from '@devdigest/shared';
import { Container } from '../src/platform/container.js';
import { loadConfig } from '../src/platform/config.js';
import type { Db } from '../src/db/client.js';
import { MockAuthProvider, MockIdentityProvider } from '../src/adapters/mocks.js';
import { LocalSecretsProvider } from '../src/adapters/secrets/local.js';
import { EncryptedSecretsProvider } from '../src/adapters/secrets/encrypted.js';
import { LocalNoAuthProvider } from '../src/adapters/auth/local.js';
import { GoogleIdentityProvider } from '../src/adapters/oidc/index.js';
import { PrincipalService } from '../src/modules/identity/principal-service.js';
import { SecretsMaintenance } from '../src/modules/secrets/service.js';

/**
 * T19 — composition-root mode switching (hermetic: no getter here touches the
 * db, so a stub handle is enough).
 */

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const GOOGLE_ENV = {
  NODE_ENV: 'test',
  AUTH_MODE: 'google',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_DOMAIN: 'onlytraf.com',
  AUTH_ADMIN_EMAILS: 'boss@onlytraf.com',
  PUBLIC_HOSTNAME: 'review.onlytraf.com',
  SECRETS_MASTER_KEY: MASTER_KEY,
} as const;

/** In-memory `SecretStore` (no transactions needed by these tests). */
class MemorySecretStore implements SecretStore<never> {
  readonly rows = new Map<string, EncryptedSecretRecord>();
  private k(ws: string, key: string) {
    return `${ws}:${key}`;
  }
  get = async (ws: string, key: string) => this.rows.get(this.k(ws, key));
  list = async (ws?: string) => [...this.rows.values()].filter((r) => !ws || r.workspaceId === ws);
  upsert = async (r: EncryptedSecretWrite) => {
    this.rows.set(this.k(r.workspaceId, r.keyName), { ...r, updatedAt: new Date() });
  };
  insertIfAbsent = async (r: EncryptedSecretWrite) => {
    if (this.rows.has(this.k(r.workspaceId, r.keyName))) return false;
    await this.upsert(r);
    return true;
  };
  transaction = async <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never);
}

class RecordingAudit implements AuditLog<never> {
  readonly events: AuditEventInput[] = [];
  record = async (e: AuditEventInput) => {
    this.events.push(e);
  };
}

const auth = () => new MockAuthProvider({ id: 'u1', email: 'you@local', name: 'You' }, { id: 'ws-1', name: 'default' });

function localContainer(overrides: ConstructorParameters<typeof Container>[2] = {}) {
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  return new Container(config, {} as Db, overrides);
}

function googleContainer(overrides: ConstructorParameters<typeof Container>[2] = {}) {
  const config = loadConfig({ ...GOOGLE_ENV } as unknown as NodeJS.ProcessEnv);
  return new Container(config, {} as Db, overrides);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('container auth/secrets wiring — local mode (unchanged)', () => {
  it('uses LocalSecretsProvider + LocalNoAuthProvider and a local Admin principal', async () => {
    const c = localContainer();
    expect(c.config.authMode).toBe('local');
    expect(c.secrets).toBeInstanceOf(LocalSecretsProvider);
    expect(c.auth).toBeInstanceOf(LocalNoAuthProvider);
    expect(c.principals).not.toBeInstanceOf(PrincipalService);
    expect(() => c.identityProvider).toThrow(/AUTH_MODE=local/);
    await expect(c.signIn()).rejects.toThrow(/AUTH_MODE=local/);
    expect(() => c.secretsMaintenance({ info() {}, warn() {}, error() {} })).toThrow(/AUTH_MODE=google/);
  });

  it('local principal = the auth user/workspace as Admin via local', async () => {
    const c = localContainer({ auth: auth() });
    await expect(c.principals.resolve({ headers: {} })).resolves.toEqual({
      userId: 'u1',
      workspaceId: 'ws-1',
      role: 'admin',
      via: 'local',
    });
  });
});

describe('container auth/secrets wiring — google mode', () => {
  it('uses EncryptedSecretsProvider + PrincipalService + GoogleIdentityProvider', () => {
    const c = googleContainer({ auth: auth(), secretStore: new MemorySecretStore() });
    expect(c.secrets).toBeInstanceOf(EncryptedSecretsProvider);
    expect(c.principals).toBeInstanceOf(PrincipalService);
    expect(c.identityProvider).toBeInstanceOf(GoogleIdentityProvider);
    expect(c.secretsMaintenance({ info() {}, warn() {}, error() {} })).toBeInstanceOf(SecretsMaintenance);
    // `auth` still resolves the team workspace (the import CLI depends on it).
    expect(c.auth).toBeInstanceOf(MockAuthProvider);
  });

  it('never falls back to env: GITHUB_TOKEN set in env + empty store → undefined', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_from_env');
    vi.stubEnv('GITHUB_PAT', 'ghp_legacy_env');
    const c = googleContainer({ auth: auth(), secretStore: new MemorySecretStore() });
    await expect(c.secrets.get('GITHUB_TOKEN')).resolves.toBeUndefined();
    const status = await c.secretsInspector.status(['GITHUB_TOKEN']);
    expect(status.get('GITHUB_TOKEN')?.state).toBe('unset');
  });

  it('writer encrypts into the store under the team workspace with attribution', async () => {
    const store = new MemorySecretStore();
    const c = googleContainer({ auth: auth(), secretStore: store });
    await c.secretsWriter.set('OPENAI_API_KEY', 'sk-test', 'user-9');
    const row = store.rows.get('ws-1:OPENAI_API_KEY');
    expect(row?.updatedBy).toBe('user-9');
    expect(Buffer.from(row!.ciphertext).toString('utf8')).not.toContain('sk-test');
    await expect(c.secrets.get('OPENAI_API_KEY')).resolves.toBe('sk-test');
    expect((await c.secretsInspector.status(['OPENAI_API_KEY'])).get('OPENAI_API_KEY')?.state).toBe('set');
    // No provider-side cache to invalidate; the call stays safe.
    expect(() => c.invalidateSecretCaches()).not.toThrow();
  });

  it('overrides win over the mode defaults', async () => {
    const idp = new MockIdentityProvider();
    const principals: PrincipalProvider = { resolve: async () => null };
    const clock: Clock = { now: () => new Date('2026-01-01T00:00:00Z') };
    const audit = new RecordingAudit();
    const c = googleContainer({
      auth: auth(),
      secretStore: new MemorySecretStore(),
      identityProvider: idp,
      principals,
      clock,
      audit,
    });
    expect(c.identityProvider).toBe(idp);
    expect(c.principals).toBe(principals);
    expect(c.clock).toBe(clock);
    expect(c.audit).toBe(audit);
    const signIn = await c.signIn();
    expect(await c.signIn()).toBe(signIn);

    const secrets = new LocalSecretsProvider('/nonexistent/secrets.json', {});
    expect(googleContainer({ auth: auth(), secrets }).secrets).toBe(secrets);
  });
});
