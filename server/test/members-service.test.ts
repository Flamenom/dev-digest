import { describe, it, expect, beforeEach } from 'vitest';
import type { AuditEventInput, MemberStatus, Role } from '@devdigest/shared';
import {
  MembersService,
  type MemberActor,
  type MembersIdentityPort,
} from '../src/modules/identity/members-service.js';
import type { IdentityTx, IdentityUser, Membership } from '../src/modules/identity/repository.js';

/**
 * T13 — MembersService against an in-memory identity fake (hermetic).
 * AC-20 list, AC-21 role/status changes + audit, AC-22 last-admin guard
 * (no write), AC-23 deactivation ends sessions + revokes tokens.
 */

const WS = 'ws-1';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const CREATED = new Date('2026-01-01T00:00:00.000Z');
const TX = { fake: 'tx' } as unknown as IdentityTx;

interface World {
  users: Map<string, IdentityUser>;
  members: Map<string, Membership>;
  sessions: Map<string, number>;
  tokens: Map<string, number>;
  writes: string[];
  locks: number;
  txSeen: unknown[];
}

function makeFake(world: World): MembersIdentityPort {
  const key = (ws: string, u: string) => `${ws}:${u}`;
  return {
    users: { findById: async (id) => world.users.get(id) },
    memberships: {
      get: async (ws, u, tx) => {
        world.txSeen.push(tx);
        return world.members.get(key(ws, u));
      },
      list: async (ws) =>
        [...world.members.values()]
          .filter((m) => m.workspaceId === ws)
          .map((m) => {
            const u = world.users.get(m.userId)!;
            return {
              userId: u.id,
              email: u.email,
              name: u.name,
              avatarUrl: u.avatarUrl,
              role: m.role,
              status: m.status,
              joinedAt: m.joinedAt ?? u.createdAt,
              lastSignInAt: u.lastSignInAt,
            };
          }),
      countActiveAdmins: async (ws, tx) => {
        world.txSeen.push(tx);
        return [...world.members.values()].filter(
          (m) => m.workspaceId === ws && m.role === 'admin' && m.status === 'active',
        ).length;
      },
      setRole: async (ws, u, role, tx) => {
        world.txSeen.push(tx);
        world.writes.push(`role:${u}:${role}`);
        const m = world.members.get(key(ws, u));
        if (!m) return undefined;
        const next = { ...m, role };
        world.members.set(key(ws, u), next);
        return next;
      },
      setStatus: async (ws, u, status, change, tx) => {
        world.txSeen.push(tx);
        world.writes.push(`status:${u}:${status}`);
        const m = world.members.get(key(ws, u));
        if (!m) return undefined;
        const next = { ...m, status, statusChangedAt: change.at, statusChangedBy: change.by };
        world.members.set(key(ws, u), next);
        return next;
      },
    },
    sessions: {
      deleteForUser: async (u, tx) => {
        world.txSeen.push(tx);
        world.writes.push(`sessions:${u}`);
        const n = world.sessions.get(u) ?? 0;
        world.sessions.set(u, 0);
        return n;
      },
    },
    apiTokens: {
      revokeForUser: async (u, _now, tx) => {
        world.txSeen.push(tx);
        world.writes.push(`tokens:${u}`);
        const n = world.tokens.get(u) ?? 0;
        world.tokens.set(u, 0);
        return n;
      },
    },
    withWorkspaceLock: async (_ws, fn) => {
      world.locks += 1;
      return fn(TX);
    },
  } as MembersIdentityPort;
}

describe('MembersService', () => {
  let world: World;
  let audit: AuditEventInput[];
  let svc: MembersService;

  function addMember(id: string, role: Role, status: MemberStatus = 'active', joinedAt: Date | null = NOW) {
    world.users.set(id, {
      id,
      email: `${id}@onlytraf.com`,
      name: id.toUpperCase(),
      avatarUrl: null,
      googleSub: `sub-${id}`,
      createdAt: CREATED,
      lastSignInAt: null,
    });
    world.members.set(`${WS}:${id}`, {
      workspaceId: WS,
      userId: id,
      role,
      status,
      statusChangedAt: null,
      statusChangedBy: null,
      joinedAt,
    });
  }

  const admin: MemberActor = { userId: 'alice', workspaceId: WS, role: 'admin', via: 'session' };

  beforeEach(() => {
    world = {
      users: new Map(),
      members: new Map(),
      sessions: new Map(),
      tokens: new Map(),
      writes: [],
      locks: 0,
      txSeen: [],
    };
    audit = [];
    svc = new MembersService({
      identity: makeFake(world),
      audit: { record: async (e, tx) => void (world.txSeen.push(tx), audit.push(e)) },
      clock: { now: () => NOW },
    });
  });

  it('AC-20: lists members with joined_at fallback and has_active_admin', async () => {
    addMember('alice', 'admin');
    addMember('bob', 'member', 'active', null);
    const res = await svc.list(WS);
    expect(res.has_active_admin).toBe(true);
    const bob = res.members.find((m) => m.user_id === 'bob')!;
    expect(bob.joined_at).toBe(CREATED.toISOString());
    expect(bob).toMatchObject({ role: 'member', status: 'active', email: 'bob@onlytraf.com' });

    world.members.set(`${WS}:alice`, { ...world.members.get(`${WS}:alice`)!, status: 'deactivated' });
    expect((await svc.list(WS)).has_active_admin).toBe(false);
  });

  it('AC-21: promotes a member under the lock and audits member.role_change', async () => {
    addMember('alice', 'admin');
    addMember('bob', 'member');
    const res = await svc.update({ ...admin, ip: '10.0.0.1' }, 'bob', { role: 'admin' });
    expect(res.role).toBe('admin');
    expect(world.locks).toBe(1);
    expect(audit).toEqual([
      {
        workspaceId: WS,
        actorUserId: 'alice',
        action: 'member.role_change',
        targetType: 'user',
        targetId: 'bob',
        ip: '10.0.0.1',
        metadata: { from_role: 'member', to_role: 'admin' },
      },
    ]);
    // Every read/write joined the lock transaction.
    expect(world.txSeen.every((t) => t === TX)).toBe(true);
  });

  it('AC-22: demoting or deactivating the last active Admin → last_admin, no write, no audit', async () => {
    addMember('alice', 'admin');
    addMember('bob', 'member');
    addMember('carol', 'admin', 'deactivated');

    await expect(svc.update(admin, 'alice', { role: 'member' })).rejects.toMatchObject({
      code: 'last_admin',
      statusCode: 409,
    });
    await expect(svc.update(admin, 'alice', { status: 'deactivated' })).rejects.toMatchObject({
      code: 'last_admin',
    });
    expect(world.writes).toEqual([]);
    expect(audit).toEqual([]);

    // With a second active Admin the demotion goes through.
    addMember('dave', 'admin');
    await expect(svc.update(admin, 'alice', { role: 'member' })).resolves.toMatchObject({
      role: 'member',
    });
  });

  it('AC-23: deactivation ends sessions + revokes tokens in the same transaction; reactivation audits', async () => {
    addMember('alice', 'admin');
    addMember('bob', 'member');
    world.sessions.set('bob', 2);
    world.tokens.set('bob', 3);

    const res = await svc.update(admin, 'bob', { status: 'deactivated' });
    expect(res.status).toBe('deactivated');
    expect(world.writes).toEqual(['status:bob:deactivated', 'sessions:bob', 'tokens:bob']);
    expect(world.members.get(`${WS}:bob`)).toMatchObject({ statusChangedBy: 'alice', statusChangedAt: NOW });
    expect(world.txSeen.every((t) => t === TX)).toBe(true);
    expect(audit[0]).toMatchObject({
      action: 'member.deactivate',
      targetId: 'bob',
      metadata: { sessions_ended: 2, tokens_revoked: 3 },
    });

    await svc.update(admin, 'bob', { status: 'active' });
    expect(audit[1]).toMatchObject({ action: 'member.reactivate', targetId: 'bob' });
    expect(world.writes.filter((w) => w.startsWith('sessions') || w.startsWith('tokens'))).toHaveLength(2);
  });

  it('no-op patch writes nothing; unknown member → not_found; non-admin / token actor rejected', async () => {
    addMember('alice', 'admin');
    addMember('bob', 'member');

    await expect(svc.update(admin, 'bob', { role: 'member' })).resolves.toMatchObject({ role: 'member' });
    expect(world.writes).toEqual([]);
    expect(audit).toEqual([]);

    await expect(svc.update(admin, 'ghost', { role: 'admin' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      svc.update({ userId: 'bob', workspaceId: WS, role: 'member' }, 'alice', { role: 'member' }),
    ).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(svc.update({ ...admin, via: 'token' }, 'bob', { role: 'admin' })).rejects.toMatchObject({
      code: 'session_required',
    });
    expect(world.writes).toEqual([]);
  });
});
