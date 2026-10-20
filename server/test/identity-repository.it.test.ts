import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { IdentityRepository } from '../src/modules/identity/repository.js';
import {
  OAUTH_FLOW_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from '../src/modules/identity/constants.js';
import { sha256Hex } from '../src/platform/crypto/tokens.js';

/**
 * T7 — identity repositories against real Postgres: concurrent first sign-in
 * (AC-13), single-use OAuth state (AC-7), session idle/absolute expiry
 * (AC-25), token liveness (AC-56/AC-23), the workspace lock behind the
 * last-admin guard (AC-22) and the actor directory (AC-48).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-10-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let seq = 0;
const claims = (label = 'user') => {
  seq += 1;
  return {
    subject: `sub-${label}-${seq}`,
    email: `${label}${seq}@onlytraf.com`,
    name: `${label} ${seq}`,
    avatarUrl: null,
  };
};

d('identity repository', () => {
  let pg: PgFixture;
  let repo: IdentityRepository;
  let ws: string;

  beforeAll(async () => {
    pg = await startPg();
    repo = new IdentityRepository(pg.handle.db);
    const [w] = await pg.handle.db.insert(t.workspaces).values({ name: 'team' }).returning();
    ws = w!.id;
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  /** A signed-up user with an active membership. */
  async function member(role: 'admin' | 'member' = 'member') {
    const { user } = await repo.users.upsertBySub(claims(role), T0);
    await repo.memberships.ensureMember(ws, user.id, role, T0);
    return user;
  }

  it('AC-13: concurrent first sign-ins for one subject → one user, one membership', async () => {
    for (let round = 0; round < 5; round++) {
      const c = claims('race');
      const signIn = async () => {
        const r = await repo.users.upsertBySub(c, T0);
        const m = await repo.memberships.ensureMember(ws, r.user.id, 'member', T0);
        return { ...r, memberCreated: m.created };
      };
      const results = await Promise.all([signIn(), signIn()]);

      expect(results[0]!.user.id).toBe(results[1]!.user.id);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results.filter((r) => r.memberCreated)).toHaveLength(1);

      const users = await pg.handle.db.select().from(t.users).where(eq(t.users.googleSub, c.subject));
      expect(users).toHaveLength(1);
      const memberships = await pg.handle.db
        .select()
        .from(t.workspaceMembers)
        .where(eq(t.workspaceMembers.userId, users[0]!.id));
      expect(memberships).toHaveLength(1);
      expect(memberships[0]!.joinedAt).toEqual(T0);
    }
  });

  it('AC-12: a returning sign-in refreshes profile fields, keeps id and role', async () => {
    const c = claims('returning');
    const first = await repo.users.upsertBySub(c, T0);
    await repo.memberships.ensureMember(ws, first.user.id, 'admin', T0);

    const later = at(HOUR);
    const second = await repo.users.upsertBySub(
      { ...c, email: `renamed-${c.email}`, name: 'Renamed', avatarUrl: 'https://lh3.googleusercontent.com/a' },
      later,
    );
    expect(second.created).toBe(false);
    expect(second.user).toMatchObject({
      id: first.user.id,
      email: `renamed-${c.email}`,
      name: 'Renamed',
      avatarUrl: 'https://lh3.googleusercontent.com/a',
      googleSub: c.subject,
      lastSignInAt: later,
    });
    // ensureMember never changes an existing role.
    const again = await repo.memberships.ensureMember(ws, first.user.id, 'member', later);
    expect(again.created).toBe(false);
    expect(again.membership.role).toBe('admin');
    expect((await repo.users.findBySub(c.subject))?.id).toBe(first.user.id);
  });

  it('AC-7: an OAuth flow is consumed once; an expired one yields nothing', async () => {
    const flow = {
      stateHash: sha256Hex('state-1'),
      bindingHash: sha256Hex('binding-1'),
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      returnTo: '/repos',
      now: T0,
    };
    await repo.oauthFlows.create(flow);

    // G3: a callback with another browser's binding matches nothing and does NOT
    // delete the row — the victim's in-flight flow survives a stray callback.
    expect(
      await repo.oauthFlows.consume(flow.stateHash, sha256Hex('someone-else'), at(1000)),
    ).toBeUndefined();
    const intact = await pg.handle.db
      .select({ stateHash: t.oauthFlows.stateHash })
      .from(t.oauthFlows)
      .where(eq(t.oauthFlows.stateHash, flow.stateHash));
    expect(intact).toHaveLength(1);

    const first = await repo.oauthFlows.consume(flow.stateHash, flow.bindingHash, at(OAUTH_FLOW_TTL_MS - 1000));
    expect(first).toMatchObject({
      bindingHash: flow.bindingHash,
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      returnTo: '/repos',
      expiresAt: at(OAUTH_FLOW_TTL_MS),
    });
    expect(await repo.oauthFlows.consume(flow.stateHash, flow.bindingHash, at(1000))).toBeUndefined();

    const stale = { ...flow, stateHash: sha256Hex('state-2') };
    await repo.oauthFlows.create(stale);
    expect(
      await repo.oauthFlows.consume(stale.stateHash, stale.bindingHash, at(OAUTH_FLOW_TTL_MS + 1)),
    ).toBeUndefined();
    // …and it is gone, not merely skipped.
    const left = await pg.handle.db
      .select()
      .from(t.oauthFlows)
      .where(eq(t.oauthFlows.stateHash, stale.stateHash));
    expect(left).toHaveLength(0);

    // Only hashes reach the table.
    const raw = await pg.handle.db.select().from(t.oauthFlows);
    expect(raw.some((r) => r.stateHash === 'state-1' || r.bindingHash === 'binding-1')).toBe(false);
  });

  it('G6: sessions and api_tokens are stored with fillfactor = 90 (HOT touch updates)', async () => {
    const rows = await pg.handle.db.execute<{ relname: string; reloptions: string[] | null }>(
      sql`select relname, reloptions from pg_class where relname in ('sessions', 'api_tokens') and relkind = 'r'`,
    );
    const byName = new Map([...rows].map((r) => [r.relname, r.reloptions ?? []]));
    expect(byName.get('sessions')).toContain('fillfactor=90');
    expect(byName.get('api_tokens')).toContain('fillfactor=90');
  });

  it('AC-25: sessions end after 24 h idle or 30 days absolute', async () => {
    const user = await member();
    const idHash = sha256Hex(`session-${user.id}`);
    const created = await repo.sessions.create({ idHash, userId: user.id, workspaceId: ws, now: T0 });
    expect(created.expiresAt).toEqual(at(SESSION_ABSOLUTE_MS));

    const live = await repo.sessions.findActiveByHash(idHash, at(23 * HOUR));
    expect(live).toMatchObject({ sessionId: created.id, userId: user.id, workspaceId: ws, role: 'member' });
    expect(await repo.sessions.findActiveByHash(idHash, at(SESSION_IDLE_MS + 1000))).toBeUndefined();

    // Used every 23 h → alive until the 30-day absolute cap.
    let lastUse = 0;
    while (lastUse + 23 * HOUR < SESSION_ABSOLUTE_MS) {
      lastUse += 23 * HOUR;
      await repo.sessions.touch(created.id, at(lastUse));
    }
    expect(await repo.sessions.findActiveByHash(idHash, at(SESSION_ABSOLUTE_MS - 1000))).toBeDefined();
    expect(await repo.sessions.findActiveByHash(idHash, at(SESSION_ABSOLUTE_MS))).toBeUndefined();
  });

  it('sessions: role read fresh, deactivated member excluded, sign-out and deleteForUser', async () => {
    const user = await member();
    const a = sha256Hex(`a-${user.id}`);
    const b = sha256Hex(`b-${user.id}`);
    await repo.sessions.create({ idHash: a, userId: user.id, workspaceId: ws, now: T0 });
    await repo.sessions.create({ idHash: b, userId: user.id, workspaceId: ws, now: T0 });

    await repo.memberships.setRole(ws, user.id, 'admin');
    expect((await repo.sessions.findActiveByHash(a, at(HOUR)))?.role).toBe('admin');

    await repo.memberships.setStatus(ws, user.id, 'deactivated', { by: null, at: at(HOUR) });
    expect(await repo.sessions.findActiveByHash(a, at(HOUR))).toBeUndefined();
    await repo.memberships.setStatus(ws, user.id, 'active', { by: null, at: at(HOUR) });

    expect(await repo.sessions.deleteByHash(a)).toBe(true);
    expect(await repo.sessions.findActiveByHash(a, at(HOUR))).toBeUndefined();
    expect(await repo.sessions.deleteByHash(a)).toBe(false);
    expect(await repo.sessions.deleteForUser(user.id)).toBe(1);
    expect(await repo.sessions.findActiveByHash(b, at(HOUR))).toBeUndefined();
  });

  it('AC-56/AC-58: api tokens — liveness, count, revoke, owner deactivation', async () => {
    const user = await member();
    const mk = (n: number, expiresAt = at(90 * 24 * HOUR)) =>
      repo.apiTokens.create({
        userId: user.id,
        workspaceId: ws,
        name: `t${n}`,
        tokenHash: sha256Hex(`ddg_pat_${user.id}_${n}`),
        prefix: 'ddg_pat_abcd',
        now: T0,
        expiresAt,
      });
    const t1 = await mk(1);
    const t2 = await mk(2);
    await mk(3, at(HOUR)); // expires soon
    const hash1 = sha256Hex(`ddg_pat_${user.id}_1`);

    expect(t1).not.toHaveProperty('tokenHash');
    expect(await repo.apiTokens.findActiveByHash(hash1, at(2 * HOUR))).toMatchObject({
      tokenId: t1.id,
      userId: user.id,
      role: 'member',
    });
    expect(await repo.apiTokens.countActive(ws, user.id, at(2 * HOUR))).toBe(2);
    expect(await repo.apiTokens.findActiveByHash(sha256Hex(`ddg_pat_${user.id}_3`), at(2 * HOUR))).toBeUndefined();
    expect(await repo.apiTokens.listForUser(ws, user.id)).toHaveLength(3);

    await repo.apiTokens.touch(t1.id, at(2 * HOUR));
    expect((await repo.apiTokens.findById(ws, t1.id))?.lastUsedAt).toEqual(at(2 * HOUR));

    expect(await repo.apiTokens.revoke(ws, t2.id, at(2 * HOUR))).toBe(true);
    expect(await repo.apiTokens.revoke(ws, t2.id, at(2 * HOUR))).toBe(false);
    expect(await repo.apiTokens.revoke(ws, 'not-a-uuid', at(2 * HOUR))).toBe(false);
    expect(await repo.apiTokens.listForUser(ws, user.id)).toHaveLength(2);

    await repo.memberships.setStatus(ws, user.id, 'deactivated', { by: null, at: at(2 * HOUR) });
    expect(await repo.apiTokens.findActiveByHash(hash1, at(2 * HOUR))).toBeUndefined();
    await repo.memberships.setStatus(ws, user.id, 'active', { by: null, at: at(2 * HOUR) });

    expect(await repo.apiTokens.revokeForUser(user.id, at(3 * HOUR))).toBe(2);
    expect(await repo.apiTokens.findActiveByHash(hash1, at(3 * HOUR))).toBeUndefined();
    expect(await repo.apiTokens.countActive(ws, user.id, at(3 * HOUR))).toBe(0);
  });

  it('AC-22 mechanism: concurrent guarded demotions under withWorkspaceLock never reach 0 admins', async () => {
    const [w] = await pg.handle.db.insert(t.workspaces).values({ name: 'lock-ws' }).returning();
    const lws = w!.id;
    const admins = await Promise.all(
      [0, 1].map(async () => {
        const { user } = await repo.users.upsertBySub(claims('admin'), T0);
        await repo.memberships.ensureMember(lws, user.id, 'admin', T0);
        return user;
      }),
    );

    // Each admin demotes the other at the same moment; the guard reads the
    // count inside the lock, so the second one sees a single remaining admin.
    const guardedDemote = (target: string) =>
      repo.withWorkspaceLock(lws, async (tx) => {
        const before = await repo.memberships.countActiveAdmins(lws, tx);
        const m = await repo.memberships.get(lws, target, tx);
        if (m?.role === 'admin' && before - 1 < 1) return 'last_admin' as const;
        // Widen the race window: without the lock both would pass the check.
        await tx.execute(sql`select pg_sleep(0.05)`);
        await repo.memberships.setRole(lws, target, 'member', tx);
        return 'ok' as const;
      });

    const results = await Promise.all([guardedDemote(admins[1]!.id), guardedDemote(admins[0]!.id)]);
    expect([...results].sort()).toEqual(['last_admin', 'ok']);
    expect(await repo.memberships.countActiveAdmins(lws)).toBe(1);
  });

  it('memberships: list joins users and falls back to users.created_at for legacy joined_at', async () => {
    const [w] = await pg.handle.db.insert(t.workspaces).values({ name: 'list-ws' }).returning();
    const lws = w!.id;
    const { user: a } = await repo.users.upsertBySub({ ...claims('x'), name: 'Alpha' }, T0);
    const { user: b } = await repo.users.upsertBySub({ ...claims('x'), name: 'Beta' }, T0);
    await repo.memberships.ensureMember(lws, a.id, 'admin', at(HOUR));
    await pg.handle.db.insert(t.workspaceMembers).values({ workspaceId: lws, userId: b.id, role: 'member' });

    const list = await repo.memberships.list(lws);
    expect(list.map((m) => m.name)).toEqual(['Alpha', 'Beta']);
    expect(list[0]).toMatchObject({ userId: a.id, role: 'admin', status: 'active', joinedAt: at(HOUR) });
    expect(list[1]!.joinedAt).toEqual(b.createdAt);

    const stamped = await repo.memberships.setStatus(lws, b.id, 'deactivated', { by: a.id, at: at(2 * HOUR) });
    expect(stamped).toMatchObject({ status: 'deactivated', statusChangedBy: a.id, statusChangedAt: at(2 * HOUR) });
    expect(await repo.memberships.countActiveAdmins(lws)).toBe(1);
    const [row] = await pg.handle.db
      .select()
      .from(t.workspaceMembers)
      .where(and(eq(t.workspaceMembers.workspaceId, lws), eq(t.workspaceMembers.userId, b.id)));
    expect(row!.status).toBe('deactivated');
  });

  it('countActiveAdmins + list: the seeded system user (google_sub NULL) is not a real Admin', async () => {
    const [w] = await pg.handle.db.insert(t.workspaces).values({ name: 'sys-ws' }).returning();
    const sws = w!.id;
    const [sys] = await pg.handle.db
      .insert(t.users)
      .values({ email: `system-${++seq}@local`, name: 'System' })
      .returning();
    await repo.memberships.ensureMember(sws, sys!.id, 'admin', T0);
    expect(await repo.memberships.countActiveAdmins(sws)).toBe(0);

    const { user } = await repo.users.upsertBySub(claims('admin'), T0);
    await repo.memberships.ensureMember(sws, user.id, 'admin', T0);
    expect(await repo.memberships.countActiveAdmins(sws)).toBe(1);

    const list = await repo.memberships.list(sws);
    expect(list.find((m) => m.userId === sys!.id)?.isSystem).toBe(true);
    expect(list.find((m) => m.userId === user.id)?.isSystem).toBe(false);
  });

  it('AC-48: actor directory flags the system user and omits unknown ids', async () => {
    const [sys] = await pg.handle.db
      .insert(t.users)
      .values({ email: 'you@local', name: 'You' })
      .returning();
    const person = await member();

    const map = await repo.lookup([sys!.id, person.id, person.id, '00000000-0000-0000-0000-000000000000', 'garbage']);
    expect(map.size).toBe(2);
    expect(map.get(sys!.id)).toEqual({ user_id: sys!.id, name: 'You', is_system: true });
    expect(map.get(person.id)).toEqual({ user_id: person.id, name: person.name });
    expect((await repo.lookup([])).size).toBe(0);
  });

  // Last in the file: it clears both tables first so the counts are exact.
  it('expiry sweeps: expired flows / sessions removed, fresh kept, batch bound respected', async () => {
    await pg.handle.db.delete(t.oauthFlows);
    await pg.handle.db.delete(t.sessions);
    const T1 = at(400 * 24 * HOUR);
    const before = (ms: number) => new Date(T1.getTime() - ms);
    const flow = (n: string, now: Date) => ({
      stateHash: sha256Hex(`sweep-state-${n}`),
      bindingHash: sha256Hex(`sweep-binding-${n}`),
      nonce: `n-${n}`,
      codeVerifier: `v-${n}`,
      returnTo: '/',
      now,
    });

    // OAuth flows: three abandoned an hour ago (expired at T1-50min).
    for (const n of ['a', 'b', 'c']) await repo.oauthFlows.create(flow(n, before(HOUR)));
    expect(await repo.oauthFlows.sweepExpired(T1, 2)).toBe(2); // batch bound
    // A new start at T1 sweeps the remaining expired one and keeps itself.
    await repo.oauthFlows.create(flow('fresh', T1));
    const flows = await pg.handle.db.select({ stateHash: t.oauthFlows.stateHash }).from(t.oauthFlows);
    expect(flows.map((f) => f.stateHash)).toEqual([sha256Hex('sweep-state-fresh')]);
    // Not expired yet at its own expiry instant minus 1 ms.
    expect(await repo.oauthFlows.sweepExpired(new Date(T1.getTime() + OAUTH_FLOW_TTL_MS - 1))).toBe(0);

    // Sessions.
    const user = await member();
    const sess = (n: string, now: Date) =>
      repo.sessions.create({ idHash: sha256Hex(`sweep-${n}-${user.id}`), userId: user.id, workspaceId: ws, now });
    await sess('abs1', before(SESSION_ABSOLUTE_MS + 2 * HOUR)); // absolute expiry T1-2h
    await sess('abs2', before(SESSION_ABSOLUTE_MS + HOUR)); // absolute expiry T1-1h
    const idle = await sess('idle', before(SESSION_IDLE_MS + HOUR)); // idle-expired, absolute live
    expect(await repo.sessions.sweepExpired(T1, { limit: 1, idle: false })).toBe(1); // batch bound
    // sessions.create sweeps ABSOLUTE expiry only — the idle-expired one stays.
    const fresh = await sess('fresh', T1);
    let ids = (await pg.handle.db.select({ id: t.sessions.id }).from(t.sessions)).map((r) => r.id).sort();
    expect(ids).toEqual([idle.id, fresh.id].sort());

    // The periodic sweep also reclaims idle-expired sessions; the fresh one survives.
    expect(await repo.sweepExpired(T1)).toEqual({ oauthFlows: 0, sessions: 1 });
    ids = (await pg.handle.db.select({ id: t.sessions.id }).from(t.sessions)).map((r) => r.id);
    expect(ids).toEqual([fresh.id]);
    expect(await repo.sessions.findActiveByHash(sha256Hex(`sweep-fresh-${user.id}`), T1)).toBeDefined();
  });
});
