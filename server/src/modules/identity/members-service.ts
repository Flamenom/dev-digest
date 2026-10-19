import type {
  AuditLog,
  Clock,
  Member,
  MemberList,
  MemberUpdate,
  Principal,
} from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import {
  ForbiddenRoleError,
  LastAdminError,
  SessionRequiredError,
} from '../../platform/auth-errors.js';
import type {
  ApiTokensRepo,
  IdentityRepository,
  IdentityTx,
  IdentityUser,
  MemberListing,
  Membership,
  MembershipsRepo,
  SessionsRepo,
} from './repository.js';

/**
 * Members administration (spec SPEC-2026-10-19-multi-user-server, AC-20–AC-23).
 *
 * Application ring: orchestrates the identity repository + audit log inside
 * ONE transaction holding the per-workspace membership advisory lock, so the
 * last-admin guard is race-safe — two Admins demoting each other concurrently
 * are serialized and the workspace never reaches zero active Admins.
 *
 * Authorization (Admin, session only) is enforced by the central route
 * policy; the checks here are defense in depth so a mis-wired route can never
 * let a Member or an API token manage members.
 */

/** The structural slice of {@link IdentityRepository} this service needs. */
export interface MembersIdentityPort {
  users: { findById: IdentityRepository['users']['findById'] };
  memberships: Pick<MembershipsRepo, 'get' | 'list' | 'countActiveAdmins' | 'setRole' | 'setStatus'>;
  sessions: Pick<SessionsRepo, 'deleteForUser'>;
  apiTokens: Pick<ApiTokensRepo, 'revokeForUser'>;
  withWorkspaceLock: IdentityRepository['withWorkspaceLock'];
}

export interface MembersServiceDeps {
  identity: MembersIdentityPort;
  audit: AuditLog<IdentityTx>;
  clock: Clock;
}

/** Who is acting (the resolved principal) plus the request IP for the audit row. */
export type MemberActor = Pick<Principal, 'userId' | 'workspaceId' | 'role'> & {
  via?: Principal['via'];
  ip?: string | null;
};

const isActiveAdmin = (m: Pick<Membership, 'role' | 'status'>) =>
  m.role === 'admin' && m.status === 'active';

function listingToDto(m: MemberListing): Member {
  return {
    user_id: m.userId,
    email: m.email,
    name: m.name,
    avatar_url: m.avatarUrl,
    role: m.role,
    status: m.status,
    joined_at: m.joinedAt.toISOString(),
    last_sign_in_at: m.lastSignInAt ? m.lastSignInAt.toISOString() : null,
  };
}

function toDto(user: IdentityUser, m: Membership): Member {
  return {
    user_id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatarUrl,
    role: m.role,
    status: m.status,
    // Q11: legacy memberships have no join time — fall back to the user's creation.
    joined_at: (m.joinedAt ?? user.createdAt).toISOString(),
    last_sign_in_at: user.lastSignInAt ? user.lastSignInAt.toISOString() : null,
  };
}

export class MembersService {
  constructor(private deps: MembersServiceDeps) {}

  /** Every member of the workspace (AC-20) + whether an active Admin remains. */
  async list(workspaceId: string): Promise<MemberList> {
    const rows = await this.deps.identity.memberships.list(workspaceId);
    return {
      members: rows.map(listingToDto),
      // The seeded system user never counts (same rule as countActiveAdmins).
      has_active_admin: rows.some((m) => !m.isSystem && isActiveAdmin(m)),
    };
  }

  /**
   * Change a member's role and/or status (AC-21). Throws `LastAdminError` with
   * NO write when the change would leave zero active Admins (AC-22).
   * Deactivation deletes every session and revokes every token of the user in
   * the same transaction (AC-23). A no-op patch writes and audits nothing.
   */
  async update(actor: MemberActor, userId: string, patch: MemberUpdate): Promise<Member> {
    if (actor.role !== 'admin') throw new ForbiddenRoleError();
    if (actor.via === 'token') throw new SessionRequiredError();
    const ws = actor.workspaceId;
    const { identity, audit, clock } = this.deps;

    return identity.withWorkspaceLock(ws, async (tx) => {
      const current = await identity.memberships.get(ws, userId, tx);
      const user = current ? await identity.users.findById(userId, tx) : undefined;
      if (!current || !user) throw new NotFoundError('Member not found');

      const nextRole = patch.role ?? current.role;
      const nextStatus = patch.status ?? current.status;
      const roleChanged = nextRole !== current.role;
      const statusChanged = nextStatus !== current.status;
      if (!roleChanged && !statusChanged) return toDto(user, current);

      // Last-admin guard (AC-22): counted under the workspace lock, before any write.
      // Only a REAL admin is guarded — the system user (googleSub null) is not
      // counted by countActiveAdmins, so it can neither satisfy nor trip the guard.
      if (
        user.googleSub !== null &&
        isActiveAdmin(current) &&
        !isActiveAdmin({ role: nextRole, status: nextStatus })
      ) {
        const admins = await identity.memberships.countActiveAdmins(ws, tx);
        if (admins - 1 < 1) throw new LastAdminError();
      }

      const now = clock.now();
      let updated: Membership = current;
      const base = {
        workspaceId: ws,
        actorUserId: actor.userId,
        targetType: 'user',
        targetId: userId,
        ip: actor.ip ?? null,
      };

      if (roleChanged) {
        updated = (await identity.memberships.setRole(ws, userId, nextRole, tx)) ?? updated;
        await audit.record(
          {
            ...base,
            action: 'member.role_change',
            metadata: { from_role: current.role, to_role: nextRole },
          },
          tx,
        );
      }

      if (statusChanged) {
        updated =
          (await identity.memberships.setStatus(
            ws,
            userId,
            nextStatus,
            { by: actor.userId, at: now },
            tx,
          )) ?? updated;
        if (nextStatus === 'deactivated') {
          const sessionsEnded = await identity.sessions.deleteForUser(userId, tx);
          const tokensRevoked = await identity.apiTokens.revokeForUser(userId, now, tx);
          await audit.record(
            {
              ...base,
              action: 'member.deactivate',
              metadata: { sessions_ended: sessionsEnded, tokens_revoked: tokensRevoked },
            },
            tx,
          );
        } else {
          await audit.record({ ...base, action: 'member.reactivate' }, tx);
        }
      }

      return toDto(user, updated);
    });
  }
}
