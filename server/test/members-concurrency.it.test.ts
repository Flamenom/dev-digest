import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { IdentityRepository } from '../src/modules/identity/repository.js';
import { AuditRepository } from '../src/modules/audit/repository.js';
import { MembersService, type MemberActor } from '../src/modules/identity/members-service.js';
import { sha256Hex } from '../src/platform/crypto/tokens.js';

/**
 * T13 — the last-admin guard against real Postgres (AC-22): two Admins
 * demoting / deactivating each other at the same time → exactly one succeeds,
 * the other gets `last_admin`, and the workspace never has zero active Admins.
 * Plus AC-23: deactivation ends sessions and revokes tokens atomically.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const T0 = new Date('2026-10-19T00:00:00.000Z');
let seq = 0;

d('members service — concurrency', () => {
  let pg: PgFixture;
  let repo: IdentityRepository;
  let svc: MembersService;

  beforeAll(async () => {
    pg = await startPg();
    repo = new IdentityRepository(pg.handle.db);
    svc = new MembersService({
      identity: repo,
      audit: new AuditRepository(pg.handle.db),
      clock: { now: () => T0 },
    });
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  async function workspace() {
    const [w] = await pg.handle.db.insert(t.workspaces).values({ name: `team-${++seq}` }).returning();
    return w!.id;
  }

  async function member(ws: string, role: 'admin' | 'member') {
    seq += 1;
    const { user } = await repo.users.upsertBySub(
      { subject: `sub-${seq}`, email: `u${seq}@onlytraf.com`, name: `U ${seq}`, avatarUrl: null },
      T0,
    );
    await repo.memberships.ensureMember(ws, user.id, role, T0);
    return user;
  }

  const actor = (ws: string, userId: string): MemberActor => ({
    userId,
    workspaceId: ws,
    role: 'admin',
    via: 'session',
  });

  it('the seeded system admin (google_sub NULL) never satisfies the last-admin guard', async () => {
    const ws = await workspace();
    const [sys] = await pg.handle.db
      .insert(t.users)
      .values({ email: `system-${++seq}@local`, name: 'System' })
      .returning();
    await repo.memberships.ensureMember(ws, sys!.id, 'admin', T0);
    expect((await svc.list(ws)).has_active_admin).toBe(false);

    const real = await member(ws, 'admin');
    expect((await svc.list(ws)).has_active_admin).toBe(true);
    await expect(svc.update(actor(ws, real.id), real.id, { role: 'member' })).rejects.toMatchObject({
      code: 'last_admin',
    });
    expect(await repo.memberships.countActiveAdmins(ws)).toBe(1);
  });

  for (const patch of [{ role: 'member' as const }, { status: 'deactivated' as const }]) {
    it(`AC-22: two Admins ${JSON.stringify(patch)} each other concurrently → one success, one last_admin`, async () => {
      for (let round = 0; round < 5; round++) {
        const ws = await workspace();
        const a = await member(ws, 'admin');
        const b = await member(ws, 'admin');

        // Sample the admin count while the race runs: it must never hit zero.
        let sampling = true;
        const samples: number[] = [];
        const sampler = (async () => {
          while (sampling) samples.push(await repo.memberships.countActiveAdmins(ws));
        })();

        const results = await Promise.allSettled([
          svc.update(actor(ws, a.id), b.id, patch),
          svc.update(actor(ws, b.id), a.id, patch),
        ]);
        sampling = false;
        await sampler;

        const ok = results.filter((r) => r.status === 'fulfilled');
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect(failed[0]!.reason).toMatchObject({ code: 'last_admin', statusCode: 409 });

        expect(await repo.memberships.countActiveAdmins(ws)).toBe(1);
        expect(samples.every((n) => n >= 1)).toBe(true);

        // Exactly one audit row for the winning change; none for the loser.
        const events = await pg.handle.db
          .select()
          .from(t.auditEvents)
          .where(eq(t.auditEvents.workspaceId, ws));
        expect(events).toHaveLength(1);
      }
    });
  }

  it('AC-23: deactivation deletes sessions and revokes tokens in one transaction', async () => {
    const ws = await workspace();
    const admin = await member(ws, 'admin');
    const bob = await member(ws, 'member');
    await repo.sessions.create({ idHash: sha256Hex(`s-${seq}`), userId: bob.id, workspaceId: ws, now: T0 });
    await repo.apiTokens.create({
      userId: bob.id,
      workspaceId: ws,
      name: 'mcp',
      tokenHash: sha256Hex(`tok-${seq}`),
      prefix: 'ddg_pat_abcd',
      now: T0,
      expiresAt: new Date(T0.getTime() + 86_400_000),
    });

    const res = await svc.update(actor(ws, admin.id), bob.id, { status: 'deactivated' });
    expect(res.status).toBe('deactivated');

    const sessions = await pg.handle.db.select().from(t.sessions).where(eq(t.sessions.userId, bob.id));
    expect(sessions).toHaveLength(0);
    expect(await repo.apiTokens.countActive(ws, bob.id, T0)).toBe(0);

    const [event] = await pg.handle.db
      .select()
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.workspaceId, ws), eq(t.auditEvents.action, 'member.deactivate')));
    expect(event).toMatchObject({ actorUserId: admin.id, targetId: bob.id });
    expect(event!.metadata).toEqual({ sessions_ended: 1, tokens_revoked: 1 });
  });
});
