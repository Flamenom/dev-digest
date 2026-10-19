import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { INSTANCE_CLAIM_CONFLICT_MESSAGE } from '../src/db/instance-claim.js';
import {
  anonymous,
  asSession,
  asToken,
  buildGoogleApp,
  googleConfig,
  TEST_MASTER_KEY,
  TEST_MASTER_KEY_2,
  TEST_MASTER_KEY_3,
} from './helpers/google-mode.js';

/**
 * google-mode boot sequence (T21): AC-5 instance claim, AC-19 no-admin
 * warning, AC-39 ignored env vars, AC-41 wrong master key still boots,
 * AC-42 rotation re-encrypts. Logs are captured from the app's pino stream.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[boot-google] Docker not available — skipping Testcontainers tests.');

function capture() {
  const lines: string[] = [];
  return {
    stream: { write: (line: string) => void lines.push(line) },
    messages: () =>
      lines.map((l) => {
        try {
          return String((JSON.parse(l) as { msg?: unknown }).msg ?? '');
        } catch {
          return l;
        }
      }),
    raw: () => lines.join('\n'),
  };
}

d('google-mode boot', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it('AC-5: a second API on the same DB refuses to start; after the first stops it starts', async () => {
    const log = capture();
    const first = await buildGoogleApp({ pg, bootChecks: true, logStream: log.stream });
    const config = googleConfig({ DATABASE_URL: pg.url });

    await expect(buildApp({ config, db: pg.handle.db })).rejects.toMatchObject({
      code: 'config_error',
      message: INSTANCE_CLAIM_CONFLICT_MESSAGE,
    });

    // AC-19: only the (non-sign-in-able) system user is Admin and the allowlist is empty.
    expect(log.messages().filter((m) => m.startsWith('No admin'))).toHaveLength(1);

    await first.close();
    const second = await buildApp({ config, db: pg.handle.db });
    await second.ready();
    await second.close();
  });

  it('AC-19: no warning when the allowlist is set, or when a real Admin exists', async () => {
    const withList = capture();
    const a = await buildGoogleApp({
      pg,
      bootChecks: true,
      logStream: withList.stream,
      env: { AUTH_ADMIN_EMAILS: 'boss@onlytraf.com' },
    });
    expect(withList.messages().some((m) => m.startsWith('No admin'))).toBe(false);
    await a.createUser({ email: 'real-admin@onlytraf.com', role: 'admin' });
    await a.close();

    const withAdmin = capture();
    const b = await buildGoogleApp({ pg, bootChecks: true, logStream: withAdmin.stream });
    expect(withAdmin.messages().some((m) => m.startsWith('No admin'))).toBe(false);
    await b.close();
  });

  it('AC-39: a managed key in the environment is named once and ignored (value never logged)', async () => {
    const before = process.env.GITHUB_TOKEN;
    const value = 'ghp_env_value_never_logged_123';
    process.env.GITHUB_TOKEN = value;
    try {
      const log = capture();
      const t = await buildGoogleApp({ pg, bootChecks: true, logStream: log.stream });
      const lines = log.messages().filter((m) => m.startsWith('GITHUB_TOKEN is set in the environment'));
      expect(lines).toHaveLength(1);
      expect(log.raw()).not.toContain(value);
      expect(await t.container.secrets.get('GITHUB_TOKEN')).toBeUndefined();
      await t.close();
    } finally {
      if (before === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = before;
    }
  });

  it('AC-41 / AC-42: a wrong master key still boots and names the key; rotation re-encrypts it', async () => {
    const secret = 'sk-or-boot-test-value';

    // Saved under key 1.
    const k1 = await buildGoogleApp({ pg, env: { SECRETS_MASTER_KEY: TEST_MASTER_KEY } });
    await k1.container.secretsWriter.set('OPENROUTER_API_KEY', secret, null);
    await k1.close();

    // Booting with key 2 succeeds and names the undecryptable key.
    const wrong = capture();
    const k2 = await buildGoogleApp({
      pg,
      bootChecks: true,
      logStream: wrong.stream,
      env: { SECRETS_MASTER_KEY: TEST_MASTER_KEY_2 },
    });
    const health = await k2.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(wrong.messages().some((m) => m.includes("can't be decrypted") && m.includes('OPENROUTER_API_KEY'))).toBe(
      true,
    );
    expect(wrong.raw()).not.toContain(secret);
    await k2.close();

    // Key 3 with key 1 as previous → one re-encryption, then the value reads back.
    const rot = capture();
    const k3 = await buildGoogleApp({
      pg,
      bootChecks: true,
      logStream: rot.stream,
      env: { SECRETS_MASTER_KEY: TEST_MASTER_KEY_3, SECRETS_MASTER_KEY_PREVIOUS: TEST_MASTER_KEY },
    });
    expect(rot.messages()).toContain('re-encrypted 1 secrets');
    expect(rot.raw()).not.toContain(secret);
    await k3.close();

    const after = capture();
    const k3only = await buildGoogleApp({
      pg,
      bootChecks: true,
      logStream: after.stream,
      env: { SECRETS_MASTER_KEY: TEST_MASTER_KEY_3 },
    });
    expect(after.messages().some((m) => m.includes("can't be decrypted"))).toBe(false);
    expect(await k3only.container.secrets.get('OPENROUTER_API_KEY')).toBe(secret);
    await k3only.close();
  });

  it('helper smoke: real PrincipalService — session + token auth, role from the DB, idle expiry', async () => {
    const t = await buildGoogleApp({ pg });
    try {
      const alice = await t.createUser({ role: 'member' });
      const session = await t.signIn(alice);
      const token = await t.createToken(alice);

      expect((await t.app.inject(anonymous({ method: 'GET', url: '/repos' }))).statusCode).toBe(401);
      expect((await t.app.inject(asSession(session, { method: 'GET', url: '/repos' }))).statusCode).toBe(200);
      expect((await t.app.inject(asToken(token, { method: 'GET', url: '/repos' }))).statusCode).toBe(200);

      const del = { method: 'DELETE' as const, url: '/runs/3e2a2b52-3b8c-4b34-9a34-0a4c8e2b1c11' };
      expect((await t.app.inject(asSession(session, del))).json().error.code).toBe('forbidden_role');
      await t.setRole(alice, 'admin'); // AC-27: next request sees the new role
      expect((await t.app.inject(asSession(session, del))).statusCode).not.toBe(403);

      await t.setStatus(alice, 'deactivated');
      expect((await t.app.inject(asToken(token, { method: 'GET', url: '/repos' }))).statusCode).toBe(401);
      await t.setStatus(alice, 'active');

      t.clock.advance(24 * 60 * 60 * 1000 + 1000); // AC-25 idle timeout
      expect((await t.app.inject(asSession(session, { method: 'GET', url: '/repos' }))).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });
});
