import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as schema from '../src/db/schema.js';
import {
  asSession,
  asToken,
  buildGoogleApp,
  TEST_UUID,
  type GoogleTestApp,
  type SessionCredential,
  type TokenCredential,
} from './helpers/google-mode.js';

/**
 * T22 — personal API tokens over HTTP (google mode, real Postgres):
 * AC-55 create (value once, hash only, list fields), AC-56 bearer auth with
 * the owner's CURRENT role (expired / revoked / deactivated owner → 401),
 * AC-57 token management is session-only, AC-58 revoke own / Admin any +
 * the 10-active limit.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[api-tokens] Docker not available — skipping Testcontainers tests.');

const DAY_MS = 86_400_000;

d('personal API token routes (google mode)', () => {
  let pg: PgFixture;
  let t: GoogleTestApp;

  beforeAll(async () => {
    pg = await startPg();
    t = await buildGoogleApp({ pg });
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  const create = (cred: SessionCredential, payload: unknown) =>
    t.app.inject(asSession(cred, { method: 'POST', url: '/tokens', payload: payload as object }));
  const list = (cred: SessionCredential) => t.app.inject(asSession(cred, { method: 'GET', url: '/tokens' }));
  const revoke = (cred: SessionCredential, id: string) =>
    t.app.inject(asSession(cred, { method: 'DELETE', url: `/tokens/${id}` }));
  const bearer = (token: string): TokenCredential => ({ authorization: `Bearer ${token}`, token });

  it('AC-55: create shows the value once; only a hash is stored; the list shows metadata only', async () => {
    const u = await t.createUser();
    const s = await t.signIn(u);
    const res = await create(s, { name: '  MCP laptop  ' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const created = res.json();
    expect(created.token).toMatch(/^ddg_pat_[A-Za-z0-9_-]{32,}$/);
    expect(created.name).toBe('MCP laptop');
    expect(created.token.startsWith(created.prefix)).toBe(true);
    expect(created.prefix.length).toBeLessThan(created.token.length);
    // Default expiry: 90 days.
    expect(Date.parse(created.expires_at) - Date.parse(created.created_at)).toBe(90 * DAY_MS);

    const l = await list(s);
    expect(l.statusCode).toBe(200);
    const items = l.json();
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(['created_at', 'expires_at', 'id', 'last_used_at', 'name', 'prefix']);
    expect(items[0]).toMatchObject({ id: created.id, prefix: created.prefix, last_used_at: null });
    expect(l.body).not.toContain(created.token);

    const rows = await t.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, u.userId));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(created.token);
    const audit = await t.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'token.create'));
    expect(audit.some((e) => e.targetId === created.id)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(created.token);

    // The token works and records its use.
    expect((await t.app.inject(asToken(bearer(created.token), { method: 'GET', url: '/members' }))).statusCode).toBe(200);
    expect((await list(s)).json()[0].last_used_at).not.toBeNull();
  });

  it('AC-55: name 1–64 chars and expiry 1–365 integer days are validated', async () => {
    const s = await t.signIn(await t.createUser());
    for (const bad of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(65) },
      { name: 'ok', expires_in_days: 0 },
      { name: 'ok', expires_in_days: 366 },
      { name: 'ok', expires_in_days: 1.5 },
      { name: 'ok', expires_in_days: '30' },
    ]) {
      expect((await create(s, bad)).statusCode, JSON.stringify(bad)).toBe(422);
    }
    const max = await create(s, { name: 'x'.repeat(64), expires_in_days: 365 });
    expect(max.statusCode).toBe(201);
    expect(Date.parse(max.json().expires_at) - Date.parse(max.json().created_at)).toBe(365 * DAY_MS);
  });

  it('AC-56: a token acts as its owner with the CURRENT role', async () => {
    const u = await t.createUser({ role: 'member' });
    const tok = bearer((await create(await t.signIn(u), { name: 'ci' })).json().token);
    const adminOnly = { method: 'DELETE' as const, url: `/repos/${TEST_UUID}` };

    const denied = await t.app.inject(asToken(tok, adminOnly));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden_role');

    await t.setRole(u, 'admin');
    // Past the guard → the handler answers (unknown repo).
    expect((await t.app.inject(asToken(tok, adminOnly))).statusCode).toBe(404);

    await t.setRole(u, 'member');
    expect((await t.app.inject(asToken(tok, adminOnly))).statusCode).toBe(403);

    await t.setStatus(u, 'deactivated');
    expect((await t.app.inject(asToken(tok, { method: 'GET', url: '/members' }))).statusCode).toBe(401);
  });

  it('AC-57: token management, member management and sign-out reject bearer tokens', async () => {
    const u = await t.createUser({ role: 'admin' });
    const tok = await t.createToken(u);
    for (const [method, url, payload] of [
      ['GET', '/tokens', undefined],
      ['POST', '/tokens', { name: 'minted-by-token' }],
      ['DELETE', `/tokens/${tok.tokenId}`, undefined],
      ['POST', '/auth/sign-out', undefined],
      ['PATCH', `/members/${u.userId}`, { role: 'member' }],
    ] as const) {
      const res = await t.app.inject(asToken(tok, { method, url, ...(payload ? { payload } : {}) }));
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('session_required');
    }
    const rows = await t.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, u.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
  });

  it('AC-58: revoke own → next use 401; Member cannot revoke another\'s; Admin can', async () => {
    const owner = await t.createUser({ role: 'member' });
    const other = await t.createUser({ role: 'member' });
    const admin = await t.createUser({ role: 'admin' });
    const [so, sx, sa] = [await t.signIn(owner), await t.signIn(other), await t.signIn(admin)];

    const own = (await create(so, { name: 'own' })).json();
    expect((await revoke(so, own.id)).statusCode).toBe(204);
    expect((await t.app.inject(asToken(bearer(own.token), { method: 'GET', url: '/members' }))).statusCode).toBe(401);
    expect((await list(so)).json().map((x: { id: string }) => x.id)).not.toContain(own.id);
    expect((await revoke(so, own.id)).statusCode).toBe(404);

    const second = (await create(so, { name: 'second' })).json();
    // Others never see it in their list.
    expect((await list(sx)).json().map((x: { id: string }) => x.id)).not.toContain(second.id);
    const foreign = await revoke(sx, second.id);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('forbidden_owner');
    expect((await t.app.inject(asToken(bearer(second.token), { method: 'GET', url: '/members' }))).statusCode).toBe(200);

    expect((await revoke(sa, second.id)).statusCode).toBe(204);
    expect((await t.app.inject(asToken(bearer(second.token), { method: 'GET', url: '/members' }))).statusCode).toBe(401);

    expect((await revoke(sa, TEST_UUID)).statusCode).toBe(404);
    expect((await revoke(sa, 'not-a-uuid')).statusCode).toBe(422);
    const audit = await t.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'token.revoke'));
    expect(audit.filter((e) => e.targetId === own.id || e.targetId === second.id)).toHaveLength(2);
  });

  it('AC-58: the 11th active token → 409 token_limit; revoking one frees a slot', async () => {
    const s = await t.signIn(await t.createUser());
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await create(s, { name: `t${i}` });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().id);
    }
    const over = await create(s, { name: 'eleventh' });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('token_limit');

    expect((await revoke(s, ids[0]!)).statusCode).toBe(204);
    expect((await create(s, { name: 'eleventh' })).statusCode).toBe(201);
  });

  // Last: moves the shared clock forward (would idle-expire earlier sessions).
  it('AC-56: an expired token → 401', async () => {
    const u = await t.createUser();
    const tok = bearer((await create(await t.signIn(u), { name: 'short', expires_in_days: 1 })).json().token);
    expect((await t.app.inject(asToken(tok, { method: 'GET', url: '/members' }))).statusCode).toBe(200);
    t.clock.advance(DAY_MS + 1000);
    const res = await t.app.inject(asToken(tok, { method: 'GET', url: '/members' }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });
});
