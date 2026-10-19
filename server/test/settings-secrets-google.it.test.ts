import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { SecretsStatusDetailed } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import {
  asSession,
  buildGoogleApp,
  TEST_MASTER_KEY,
  TEST_MASTER_KEY_2,
  type GoogleTestApp,
  type SessionCredential,
} from './helpers/google-mode.js';

/**
 * T23 — Settings + secrets surface in google mode (AC-38, AC-40, AC-41, Q1, Q8).
 * Real Postgres + EncryptedSecretsProvider; provider HTTP calls are answered
 * by a `fetch` stub (no network) that records the credential it was sent.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[settings-secrets-google] Docker not available — skipping.');

const STATUS = { method: 'GET' as const, url: '/settings/secrets-status' };

/** Answers GitHub `GET /user` and OpenRouter `GET /models`; records auth headers. */
function stubProviderFetch() {
  const auth: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(
      init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined),
    );
    auth.push(headers.get('authorization') ?? '');
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/user')) return json({ login: 'octo-admin' });
    if (url.includes('/models')) return json({ data: [] });
    return new Response('not stubbed', { status: 404 });
  });
  return { spy, auth };
}

d('settings + secrets (google mode, Testcontainers pg)', () => {
  let pg: PgFixture;
  let t1: GoogleTestApp;
  let adminA: { name: string; session: SessionCredential; userId: string };
  let adminB: { name: string; session: SessionCredential; userId: string };

  beforeAll(async () => {
    pg = await startPg();
    t1 = await buildGoogleApp({ pg, env: { SECRETS_MASTER_KEY: TEST_MASTER_KEY } });
    const a = await t1.createUser({ name: 'Alice Admin', role: 'admin' });
    const b = await t1.createUser({ name: 'Bob Admin', role: 'admin' });
    adminA = { name: a.name, userId: a.userId, session: await t1.signIn(a) };
    adminB = { name: b.name, userId: b.userId, session: await t1.signIn(b) };
  }, 120_000);
  afterAll(async () => {
    await t1?.close();
    await pg?.stop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('status: booleans + strict states, no value hints; unset everywhere at first (AC-38, Q1)', async () => {
    const res = await t1.app.inject(asSession(adminA.session, STATUS));
    expect(res.statusCode).toBe(200);
    const body = SecretsStatusDetailed.parse(res.json());
    for (const p of ['openai', 'anthropic', 'openrouter', 'github', 'gitlab'] as const) {
      expect(body[p]).toBe(false);
      expect(body.states[p]).toEqual({ state: 'unset', updated_at: null, updated_by: null });
      // Only the three contract fields — no length / prefix / last-chars hints.
      expect(Object.keys(body.states[p]).sort()).toEqual(['state', 'updated_at', 'updated_by']);
    }
  });

  it('save GitHub token → next call uses it without restart; status shows who/when (AC-40)', async () => {
    const { auth } = stubProviderFetch();
    const first = 'ghp_first_secret_token_value_1';
    const second = 'ghp_second_secret_token_value_2';

    const r1 = await t1.app.inject(
      asSession(adminA.session, {
        method: 'POST',
        url: '/settings/test-connection',
        payload: { provider: 'github', key: first },
      }),
    );
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ provider: 'github', ok: true, message: 'Connected as @octo-admin' });
    expect(r1.payload).not.toContain(first);
    expect(auth.at(-1)).toContain(first);

    let status = SecretsStatusDetailed.parse((await t1.app.inject(asSession(adminA.session, STATUS))).json());
    expect(status.github).toBe(true);
    expect(status.states.github.state).toBe('set');
    expect(status.states.github.updated_by).toMatchObject({ user_id: adminA.userId, name: adminA.name });
    const firstAt = status.states.github.updated_at;
    expect(firstAt).not.toBeNull();

    // Bob replaces it; the very next provider call uses the new value.
    const r2 = await t1.app.inject(
      asSession(adminB.session, {
        method: 'POST',
        url: '/settings/test-connection',
        payload: { provider: 'github', key: second },
      }),
    );
    expect(r2.json().ok).toBe(true);
    expect(auth.at(-1)).toContain(second);
    const gh = await t1.container.github();
    await gh.currentLogin();
    expect(auth.at(-1)).toContain(second);

    const statusRes = await t1.app.inject(asSession(adminA.session, STATUS));
    status = SecretsStatusDetailed.parse(statusRes.json());
    expect(status.states.github.updated_by).toMatchObject({ user_id: adminB.userId, name: adminB.name });
    expect(new Date(status.states.github.updated_at!).getTime()).toBeGreaterThanOrEqual(
      new Date(firstAt!).getTime(),
    );
    // No API response carries a stored value.
    for (const payload of [r1.payload, r2.payload, statusRes.payload]) {
      expect(payload).not.toContain(first);
      expect(payload).not.toContain(second);
    }
  });

  it('wrong-key row → undecryptable; features fail with secret_undecryptable; re-enter → set (AC-41)', async () => {
    const secret = 'sk-or-old-master-key-value';
    // Written under another master key (same DB, same workspace).
    const other = await buildGoogleApp({ pg, env: { SECRETS_MASTER_KEY: TEST_MASTER_KEY_2 } });
    await other.container.secretsWriter.set('OPENROUTER_API_KEY', secret, null);
    await other.close();

    const statusRes = await t1.app.inject(asSession(adminA.session, STATUS));
    const status = SecretsStatusDetailed.parse(statusRes.json());
    expect(status.openrouter).toBe(false);
    expect(status.states.openrouter.state).toBe('undecryptable');
    expect(statusRes.payload).not.toContain(secret);

    // A feature that needs OpenRouter (the review engine resolves it this way).
    t1.container.invalidateSecretCaches();
    await expect(t1.container.llm('openrouter')).rejects.toMatchObject({ code: 'secret_undecryptable' });

    // The connection test without a key surfaces the stable error, not a failed test.
    const test = await t1.app.inject(
      asSession(adminA.session, {
        method: 'POST',
        url: '/settings/test-connection',
        payload: { provider: 'openrouter' },
      }),
    );
    expect(test.statusCode).toBe(409);
    expect(test.json().error.code).toBe('secret_undecryptable');
    expect(test.json().error.message).toContain('re-enter it in Settings');
    expect(test.payload).not.toContain(secret);

    // Re-entering the key through the save-and-test flow recovers.
    stubProviderFetch();
    const fresh = 'sk-or-fresh-value-123';
    const save = await t1.app.inject(
      asSession(adminA.session, {
        method: 'POST',
        url: '/settings/test-connection',
        payload: { provider: 'openrouter', key: fresh },
      }),
    );
    expect(save.statusCode).toBe(200);
    expect(save.payload).not.toContain(fresh);
    const after = SecretsStatusDetailed.parse((await t1.app.inject(asSession(adminA.session, STATUS))).json());
    expect(after.openrouter).toBe(true);
    expect(after.states.openrouter.state).toBe('set');
    expect(after.states.openrouter.updated_by).toMatchObject({ user_id: adminA.userId });
  });

  it('two Admins saving the same setting → exactly one workspace-wide row (Q8)', async () => {
    const put = (s: SessionCredential, value: unknown) =>
      t1.app.inject(
        asSession(s, { method: 'PUT', url: '/settings', payload: { polling_interval_min: value } }),
      );
    const a = await put(adminA.session, 7);
    expect(a.statusCode).toBe(200);
    const b = await put(adminB.session, 9);
    expect(b.statusCode).toBe(200);
    expect(b.json().polling_interval_min).toBe(9);

    // Concurrent first saves of a brand-new key also collapse to one row.
    await Promise.all([
      t1.app.inject(asSession(adminA.session, { method: 'PUT', url: '/settings', payload: { theme: 'dark' } })),
      t1.app.inject(asSession(adminB.session, { method: 'PUT', url: '/settings', payload: { theme: 'light' } })),
    ]);

    for (const key of ['polling_interval_min', 'theme']) {
      const rows = await t1.db
        .select({ userId: t.settings.userId, value: t.settings.value })
        .from(t.settings)
        .where(and(eq(t.settings.workspaceId, t1.workspaceId), eq(t.settings.key, key)));
      expect(rows).toHaveLength(1);
    }
    const get = await t1.app.inject(asSession(adminB.session, { method: 'GET', url: '/settings' }));
    expect(get.json().polling_interval_min).toBe(9);
    expect(['dark', 'light']).toContain(get.json().theme);
  });

  it('concurrent saves of the same two keys in opposite order both succeed (advisory locks taken in key order)', async () => {
    // Over HTTP: two Admins PUT the same pair of keys, written in opposite order.
    for (let round = 0; round < 5; round++) {
      const [a, b] = await Promise.all([
        t1.app.inject(
          asSession(adminA.session, {
            method: 'PUT',
            url: '/settings',
            payload: { theme: 'dark', polling_interval_min: 11 + round },
          }),
        ),
        t1.app.inject(
          asSession(adminB.session, {
            method: 'PUT',
            url: '/settings',
            payload: { polling_interval_min: 21 + round, theme: 'light' },
          }),
        ),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
    }

    // At the repository: route validation normalizes key order, so drive the
    // opposite caller order directly — without sorted locking this deadlocks
    // (Postgres aborts one transaction with 40P01).
    const repo = t1.container.settingsRepo;
    for (let round = 0; round < 10; round++) {
      await expect(
        Promise.all([
          repo.upsert(t1.workspaceId, adminA.userId, { theme: 'dark', polling_interval_min: 30 + round }),
          repo.upsert(t1.workspaceId, adminB.userId, { polling_interval_min: 40 + round, theme: 'light' }),
        ]),
      ).resolves.toBeDefined();
    }

    for (const key of ['polling_interval_min', 'theme']) {
      const rows = await t1.db
        .select({ id: t.settings.id })
        .from(t.settings)
        .where(and(eq(t.settings.workspaceId, t1.workspaceId), eq(t.settings.key, key)));
      expect(rows).toHaveLength(1);
    }
  });
});
