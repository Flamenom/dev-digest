import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as schema from '../src/db/schema.js';
import {
  asSession,
  asToken,
  buildGoogleApp,
  TEST_UUID,
  type GoogleTestApp,
  type SessionCredential,
  type TestUser,
} from './helpers/google-mode.js';

/**
 * T22 — Members routes over HTTP (google mode, real Postgres):
 * AC-20 list, AC-21 role/status changes + audit, AC-22 last-admin guard
 * (incl. concurrent mutual demotion), AC-23 deactivation ends sessions and
 * tokens, AC-27 a demoted Admin's very next admin call → 403, plus the
 * session-only / Admin-only / validation edges.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[members] Docker not available — skipping Testcontainers tests.');

d('members routes (google mode)', () => {
  let pg: PgFixture;
  let t: GoogleTestApp;
  /** The one real Admin left after the AC-22 test. */
  let admin: TestUser;
  let adminSession: SessionCredential;

  beforeAll(async () => {
    pg = await startPg();
    t = await buildGoogleApp({ pg });
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  const patch = (cred: SessionCredential, userId: string, payload: unknown) =>
    t.app.inject(asSession(cred, { method: 'PATCH', url: `/members/${userId}`, payload: payload as object }));

  const auditFor = async (action: string, targetId: string) =>
    t.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, action), eq(schema.auditEvents.targetId, targetId)));

  it('AC-22: concurrent mutual demotion → exactly one succeeds; the last Admin cannot demote or deactivate themselves (409)', async () => {
    const a = await t.createUser({ role: 'admin' });
    const b = await t.createUser({ role: 'admin' });
    const [sa, sb] = [await t.signIn(a), await t.signIn(b)];

    const [ra, rb] = await Promise.all([patch(sa, b.userId, { role: 'member' }), patch(sb, a.userId, { role: 'member' })]);
    // Exactly one wins. The loser is rejected either by the guard (its role was
    // re-read after the winner's commit → 403 forbidden_role, AC-27) or by the
    // serialized last-admin guard (→ 409 last_admin) — depending on timing.
    expect([ra.statusCode, rb.statusCode].filter((c) => c === 200)).toHaveLength(1);
    const loser = ra.statusCode === 200 ? rb : ra;
    expect([
      [403, 'forbidden_role'],
      [409, 'last_admin'],
    ]).toContainEqual([loser.statusCode, loser.json().error.code]);

    const winner = ra.statusCode === 200 ? a : b;
    const winnerSession = ra.statusCode === 200 ? sa : sb;
    const list = await t.app.inject(asSession(winnerSession, { method: 'GET', url: '/members' }));
    const admins = list.json().members.filter(
      (m: { role: string; status: string; user_id: string }) =>
        m.role === 'admin' && m.status === 'active' && m.user_id !== t.systemUserId,
    );
    expect(admins.map((m: { user_id: string }) => m.user_id)).toEqual([winner.userId]);

    for (const body of [{ role: 'member' }, { status: 'deactivated' }]) {
      const self = await patch(winnerSession, winner.userId, body);
      expect(self.statusCode).toBe(409);
      expect(self.json().error.code).toBe('last_admin');
    }
    admin = winner;
    adminSession = winnerSession;
  });

  it('AC-20: any member lists every member with the documented fields', async () => {
    const m = await t.createUser({ role: 'member' });
    const res = await t.app.inject(asSession(await t.signIn(m), { method: 'GET', url: '/members' }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.has_active_admin).toBe(true);
    const me = body.members.find((x: { user_id: string }) => x.user_id === m.userId);
    expect(Object.keys(me).sort()).toEqual(
      ['avatar_url', 'email', 'joined_at', 'last_sign_in_at', 'name', 'role', 'status', 'user_id'].sort(),
    );
    expect(me).toMatchObject({ email: m.email, name: m.name, role: 'member', status: 'active' });

    // A token may read the list (Member route, not session-only).
    const tok = await t.createToken(m);
    expect((await t.app.inject(asToken(tok, { method: 'GET', url: '/members' }))).statusCode).toBe(200);
  });

  it('AC-21 + AC-27: promotion and demotion apply on the very next request and are audited', async () => {
    const m = await t.createUser({ role: 'member' });
    const other = await t.createUser({ role: 'member' });
    const ms = await t.signIn(m);

    // Member → 403 forbidden_role on an Admin route, no change.
    const denied = await patch(ms, other.userId, { role: 'admin' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden_role');

    const promoted = await patch(adminSession, m.userId, { role: 'admin' });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ user_id: m.userId, role: 'admin', status: 'active' });
    expect(await auditFor('member.role_change', m.userId)).toHaveLength(1);

    // Same session, no re-sign-in: now an Admin.
    expect((await patch(ms, other.userId, { status: 'active' })).statusCode).toBe(200);

    expect((await patch(adminSession, m.userId, { role: 'member' })).statusCode).toBe(200);
    const after = await patch(ms, other.userId, { role: 'admin' });
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('forbidden_role');
    expect(await auditFor('member.role_change', m.userId)).toHaveLength(2);
  });

  it('AC-21 + AC-23: deactivation ends every session and token before returning; reactivation is audited', async () => {
    const m = await t.createUser({ role: 'member' });
    const [s1, s2] = [await t.signIn(m), await t.signIn(m)];
    const tok = await t.createToken(m);
    expect((await t.app.inject(asToken(tok, { method: 'GET', url: '/members' }))).statusCode).toBe(200);

    const res = await patch(adminSession, m.userId, { status: 'deactivated' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user_id: m.userId, status: 'deactivated' });

    for (const cred of [s1, s2]) {
      expect((await t.app.inject(asSession(cred, { method: 'GET', url: '/members' }))).statusCode).toBe(401);
    }
    expect((await t.app.inject(asToken(tok, { method: 'GET', url: '/members' }))).statusCode).toBe(401);
    expect(await auditFor('member.deactivate', m.userId)).toHaveLength(1);

    const list = await t.app.inject(asSession(adminSession, { method: 'GET', url: '/members' }));
    expect(list.json().members.find((x: { user_id: string }) => x.user_id === m.userId).status).toBe('deactivated');

    const back = await patch(adminSession, m.userId, { status: 'active' });
    expect(back.statusCode).toBe(200);
    expect(back.json().status).toBe('active');
    expect(await auditFor('member.reactivate', m.userId)).toHaveLength(1);
    // The old session stays dead (it was deleted, not suspended).
    expect((await t.app.inject(asSession(s1, { method: 'GET', url: '/members' }))).statusCode).toBe(401);
  });

  it('session only, validation and unknown targets', async () => {
    const m = await t.createUser({ role: 'member' });
    const adminToken = await t.createToken(admin);
    const viaToken = await t.app.inject(
      asToken(adminToken, { method: 'PATCH', url: `/members/${m.userId}`, payload: { role: 'admin' } }),
    );
    expect(viaToken.statusCode).toBe(403);
    expect(viaToken.json().error.code).toBe('session_required');

    expect((await patch(adminSession, m.userId, {})).statusCode).toBe(422);
    expect((await patch(adminSession, m.userId, { role: 'owner' })).statusCode).toBe(422);
    expect((await patch(adminSession, 'not-a-uuid', { role: 'admin' })).statusCode).toBe(422);
    const missing = await patch(adminSession, TEST_UUID, { role: 'admin' });
    expect(missing.statusCode).toBe(404);

    // Nothing changed for m.
    const list = await t.app.inject(asSession(adminSession, { method: 'GET', url: '/members' }));
    expect(list.json().members.find((x: { user_id: string }) => x.user_id === m.userId).role).toBe('member');
  });
});
