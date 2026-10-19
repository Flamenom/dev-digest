import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { MemberStatus, Role } from '@devdigest/shared';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { WorkspaceMemberRow } from '../../../db/rows.js';
import { execOf, type IdentityExecutor, type IdentityTx } from './users.repo.js';

// ---- Domain types -----------------------------------------------------------

export interface Membership {
  workspaceId: string;
  userId: string;
  role: Role;
  status: MemberStatus;
  statusChangedAt: Date | null;
  statusChangedBy: string | null;
  /** Null for memberships that predate migration 0021 (Q11). */
  joinedAt: Date | null;
}

/** One row of the Members screen: membership joined with its user (AC-20). */
export interface MemberListing {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: Role;
  status: MemberStatus;
  /** `joined_at`, falling back to the user's creation time for legacy rows (Q11). */
  joinedAt: Date;
  lastSignInAt: Date | null;
}

export interface EnsureMemberResult {
  membership: Membership;
  /** True when this call created the membership. */
  created: boolean;
}

function toMembership(row: WorkspaceMemberRow): Membership {
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role,
    status: row.status,
    statusChangedAt: row.statusChangedAt,
    statusChangedBy: row.statusChangedBy,
    joinedAt: row.joinedAt,
  };
}

/**
 * Advisory-lock key for one workspace's membership mutations. `hashtext` is
 * int4; collisions across workspaces only over-serialize, never under-serialize.
 */
const memberLockKey = (workspaceId: string) => `members:${workspaceId}`;

// ---- Repository -------------------------------------------------------------

/** `workspace_members` data access. Every query is scoped by workspace. */
export class MembershipsRepo {
  constructor(private db: Db) {}

  /**
   * Create the membership if absent (`ON CONFLICT DO NOTHING`); an existing
   * membership — its role and status — is never changed here (AC-12, AC-14).
   */
  async ensureMember(
    workspaceId: string,
    userId: string,
    role: Role,
    now: Date,
    tx?: IdentityExecutor,
  ): Promise<EnsureMemberResult> {
    const exec = execOf(this.db, tx);
    const [inserted] = await exec
      .insert(t.workspaceMembers)
      .values({ workspaceId, userId, role, status: 'active', joinedAt: now })
      .onConflictDoNothing({ target: [t.workspaceMembers.workspaceId, t.workspaceMembers.userId] })
      .returning();
    if (inserted) return { membership: toMembership(inserted), created: true };
    const existing = await this.get(workspaceId, userId, tx);
    // Only reachable if the row was deleted between the two statements.
    if (!existing) throw new Error('ensureMember: membership vanished after conflict');
    return { membership: existing, created: false };
  }

  async get(
    workspaceId: string,
    userId: string,
    tx?: IdentityExecutor,
  ): Promise<Membership | undefined> {
    const [row] = await execOf(this.db, tx)
      .select()
      .from(t.workspaceMembers)
      .where(
        and(eq(t.workspaceMembers.workspaceId, workspaceId), eq(t.workspaceMembers.userId, userId)),
      );
    return row ? toMembership(row) : undefined;
  }

  /** Every member of the workspace with user details, by name then email. */
  async list(workspaceId: string, tx?: IdentityExecutor): Promise<MemberListing[]> {
    const rows = await execOf(this.db, tx)
      .select({
        userId: t.users.id,
        email: t.users.email,
        name: t.users.name,
        avatarUrl: t.users.avatarUrl,
        role: t.workspaceMembers.role,
        status: t.workspaceMembers.status,
        joinedAt: t.workspaceMembers.joinedAt,
        userCreatedAt: t.users.createdAt,
        lastSignInAt: t.users.lastSignInAt,
      })
      .from(t.workspaceMembers)
      .innerJoin(t.users, eq(t.users.id, t.workspaceMembers.userId))
      .where(eq(t.workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(t.users.name), asc(t.users.email));
    return rows.map(({ userCreatedAt, joinedAt, ...r }) => ({
      ...r,
      joinedAt: joinedAt ?? userCreatedAt,
    }));
  }

  /**
   * Active Admins in the workspace. Call it inside {@link withWorkspaceLock}
   * when the answer guards a mutation (last-admin guard, AC-22).
   */
  async countActiveAdmins(workspaceId: string, tx?: IdentityExecutor): Promise<number> {
    const [row] = await execOf(this.db, tx)
      .select({ n: count() })
      .from(t.workspaceMembers)
      .where(
        and(
          eq(t.workspaceMembers.workspaceId, workspaceId),
          eq(t.workspaceMembers.role, 'admin'),
          eq(t.workspaceMembers.status, 'active'),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /** Change a member's role; undefined when no such membership. */
  async setRole(
    workspaceId: string,
    userId: string,
    role: Role,
    tx?: IdentityExecutor,
  ): Promise<Membership | undefined> {
    const [row] = await execOf(this.db, tx)
      .update(t.workspaceMembers)
      .set({ role })
      .where(
        and(eq(t.workspaceMembers.workspaceId, workspaceId), eq(t.workspaceMembers.userId, userId)),
      )
      .returning();
    return row ? toMembership(row) : undefined;
  }

  /** Deactivate / reactivate a member, stamping who and when. */
  async setStatus(
    workspaceId: string,
    userId: string,
    status: MemberStatus,
    change: { by: string | null; at: Date },
    tx?: IdentityExecutor,
  ): Promise<Membership | undefined> {
    const [row] = await execOf(this.db, tx)
      .update(t.workspaceMembers)
      .set({ status, statusChangedAt: change.at, statusChangedBy: change.by })
      .where(
        and(eq(t.workspaceMembers.workspaceId, workspaceId), eq(t.workspaceMembers.userId, userId)),
      )
      .returning();
    return row ? toMembership(row) : undefined;
  }

  /**
   * Run `fn` in ONE transaction holding the workspace's membership advisory
   * lock (`pg_advisory_xact_lock`, released at commit/rollback). Every
   * membership mutation that reads-then-writes (last-admin guard, sign-in
   * role bootstrap) goes through here, so concurrent requests are serialized
   * and the workspace never passes through a zero-Admin state (AC-13, AC-22).
   */
  withWorkspaceLock<T>(workspaceId: string, fn: (tx: IdentityTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${memberLockKey(workspaceId)}::text))`);
      return fn(tx);
    });
  }
}
