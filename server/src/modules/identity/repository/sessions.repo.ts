import { and, eq, gt } from 'drizzle-orm';
import type { Role } from '@devdigest/shared';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../constants.js';
import { execOf, type IdentityExecutor } from './users.repo.js';

// ---- Domain types -----------------------------------------------------------

export interface NewSession {
  /** sha256 of the cookie value — the raw session id is NEVER passed here. */
  idHash: string;
  userId: string;
  workspaceId: string;
  /** Issue time (injected clock); expiry = now + absolute lifetime. */
  now: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  workspaceId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

/**
 * A live session joined with its CURRENT membership — role and status are
 * read from the database on every lookup (AC-27).
 */
export interface ActiveSession {
  sessionId: string;
  userId: string;
  workspaceId: string;
  role: Role;
  lastSeenAt: Date;
  expiresAt: Date;
}

// ---- Repository -------------------------------------------------------------

/** `sessions` data access. Only hashes of session ids are stored or queried. */
export class SessionsRepo {
  constructor(private db: Db) {}

  async create(input: NewSession, tx?: IdentityExecutor): Promise<SessionRecord> {
    const [row] = await execOf(this.db, tx)
      .insert(t.sessions)
      .values({
        idHash: input.idHash,
        userId: input.userId,
        workspaceId: input.workspaceId,
        createdAt: input.now,
        lastSeenAt: input.now,
        expiresAt: new Date(input.now.getTime() + SESSION_ABSOLUTE_MS),
      })
      .returning({
        id: t.sessions.id,
        userId: t.sessions.userId,
        workspaceId: t.sessions.workspaceId,
        createdAt: t.sessions.createdAt,
        lastSeenAt: t.sessions.lastSeenAt,
        expiresAt: t.sessions.expiresAt,
      });
    return row!;
  }

  /**
   * The session for `idHash` iff, at `now`: it is within its absolute
   * lifetime, it was seen less than the idle timeout ago (AC-25), and its
   * user's membership in the session's workspace is active (AC-23, AC-27).
   */
  async findActiveByHash(
    idHash: string,
    now: Date,
    tx?: IdentityExecutor,
  ): Promise<ActiveSession | undefined> {
    const idleCutoff = new Date(now.getTime() - SESSION_IDLE_MS);
    const [row] = await execOf(this.db, tx)
      .select({
        sessionId: t.sessions.id,
        userId: t.sessions.userId,
        workspaceId: t.sessions.workspaceId,
        role: t.workspaceMembers.role,
        lastSeenAt: t.sessions.lastSeenAt,
        expiresAt: t.sessions.expiresAt,
      })
      .from(t.sessions)
      .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
      .innerJoin(
        t.workspaceMembers,
        and(
          eq(t.workspaceMembers.workspaceId, t.sessions.workspaceId),
          eq(t.workspaceMembers.userId, t.sessions.userId),
        ),
      )
      .where(
        and(
          eq(t.sessions.idHash, idHash),
          gt(t.sessions.expiresAt, now),
          gt(t.sessions.lastSeenAt, idleCutoff),
          eq(t.workspaceMembers.status, 'active'),
        ),
      );
    return row;
  }

  /** Record activity (callers throttle to one write per TOUCH_THROTTLE_MS). */
  async touch(sessionId: string, at: Date, tx?: IdentityExecutor): Promise<void> {
    await execOf(this.db, tx)
      .update(t.sessions)
      .set({ lastSeenAt: at })
      .where(eq(t.sessions.id, sessionId));
  }

  /** Sign-out: delete the session server-side (AC-26). True when a row went. */
  async deleteByHash(idHash: string, tx?: IdentityExecutor): Promise<boolean> {
    const rows = await execOf(this.db, tx)
      .delete(t.sessions)
      .where(eq(t.sessions.idHash, idHash))
      .returning({ id: t.sessions.id });
    return rows.length > 0;
  }

  /** Deactivation: drop every session of the user (AC-23). Returns the count. */
  async deleteForUser(userId: string, tx?: IdentityExecutor): Promise<number> {
    const rows = await execOf(this.db, tx)
      .delete(t.sessions)
      .where(eq(t.sessions.userId, userId))
      .returning({ id: t.sessions.id });
    return rows.length;
  }
}
