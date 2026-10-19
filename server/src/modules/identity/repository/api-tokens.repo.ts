import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Role } from '@devdigest/shared';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { ApiTokenRow } from '../../../db/rows.js';
import { execOf, isUuid, type IdentityExecutor } from './users.repo.js';

// ---- Domain types -----------------------------------------------------------

export interface NewApiToken {
  userId: string;
  workspaceId: string;
  name: string;
  /** sha256 of the token value — the value itself is never passed here. */
  tokenHash: string;
  /** Non-secret display prefix (`ddg_pat_` + 4 chars). */
  prefix: string;
  now: Date;
  expiresAt: Date;
}

/** A stored token's metadata. Never carries the value or its hash. */
export interface ApiTokenRecord {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** A usable token resolved with its owner's CURRENT role (AC-56). */
export interface ActiveApiToken {
  tokenId: string;
  userId: string;
  workspaceId: string;
  role: Role;
  lastUsedAt: Date | null;
}

function toRecord(row: ApiTokenRow): ApiTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

// ---- Repository -------------------------------------------------------------

/** `api_tokens` data access. Only token hashes are stored or queried. */
export class ApiTokensRepo {
  constructor(private db: Db) {}

  async create(input: NewApiToken, tx?: IdentityExecutor): Promise<ApiTokenRecord> {
    const [row] = await execOf(this.db, tx)
      .insert(t.apiTokens)
      .values({
        userId: input.userId,
        workspaceId: input.workspaceId,
        name: input.name,
        tokenHash: input.tokenHash,
        prefix: input.prefix,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      })
      .returning();
    return toRecord(row!);
  }

  /**
   * The token for `tokenHash` iff, at `now`: not revoked, not expired, and its
   * owner's membership in the token's workspace is active (AC-23, AC-56).
   */
  async findActiveByHash(
    tokenHash: string,
    now: Date,
    tx?: IdentityExecutor,
  ): Promise<ActiveApiToken | undefined> {
    const [row] = await execOf(this.db, tx)
      .select({
        tokenId: t.apiTokens.id,
        userId: t.apiTokens.userId,
        workspaceId: t.apiTokens.workspaceId,
        role: t.workspaceMembers.role,
        lastUsedAt: t.apiTokens.lastUsedAt,
      })
      .from(t.apiTokens)
      .innerJoin(
        t.workspaceMembers,
        and(
          eq(t.workspaceMembers.workspaceId, t.apiTokens.workspaceId),
          eq(t.workspaceMembers.userId, t.apiTokens.userId),
        ),
      )
      .where(
        and(
          eq(t.apiTokens.tokenHash, tokenHash),
          isNull(t.apiTokens.revokedAt),
          gt(t.apiTokens.expiresAt, now),
          eq(t.workspaceMembers.status, 'active'),
        ),
      );
    return row;
  }

  /** One token of the workspace by id (ownership checks before revoke). */
  async findById(
    workspaceId: string,
    tokenId: string,
    tx?: IdentityExecutor,
  ): Promise<ApiTokenRecord | undefined> {
    if (!isUuid(tokenId)) return undefined;
    const [row] = await execOf(this.db, tx)
      .select()
      .from(t.apiTokens)
      .where(and(eq(t.apiTokens.workspaceId, workspaceId), eq(t.apiTokens.id, tokenId)));
    return row ? toRecord(row) : undefined;
  }

  /** The user's unrevoked tokens in the workspace (expired ones included), newest first. */
  async listForUser(
    workspaceId: string,
    userId: string,
    tx?: IdentityExecutor,
  ): Promise<ApiTokenRecord[]> {
    const rows = await execOf(this.db, tx)
      .select()
      .from(t.apiTokens)
      .where(
        and(
          eq(t.apiTokens.workspaceId, workspaceId),
          eq(t.apiTokens.userId, userId),
          isNull(t.apiTokens.revokedAt),
        ),
      )
      .orderBy(desc(t.apiTokens.createdAt));
    return rows.map(toRecord);
  }

  /** Unrevoked, unexpired tokens of the user (the AC-58 limit). */
  async countActive(
    workspaceId: string,
    userId: string,
    now: Date,
    tx?: IdentityExecutor,
  ): Promise<number> {
    const [row] = await execOf(this.db, tx)
      .select({ n: count() })
      .from(t.apiTokens)
      .where(
        and(
          eq(t.apiTokens.workspaceId, workspaceId),
          eq(t.apiTokens.userId, userId),
          isNull(t.apiTokens.revokedAt),
          gt(t.apiTokens.expiresAt, now),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /** Revoke one token; true when it was unrevoked before this call. */
  async revoke(
    workspaceId: string,
    tokenId: string,
    now: Date,
    tx?: IdentityExecutor,
  ): Promise<boolean> {
    if (!isUuid(tokenId)) return false;
    const rows = await execOf(this.db, tx)
      .update(t.apiTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(t.apiTokens.workspaceId, workspaceId),
          eq(t.apiTokens.id, tokenId),
          isNull(t.apiTokens.revokedAt),
        ),
      )
      .returning({ id: t.apiTokens.id });
    return rows.length > 0;
  }

  /** Deactivation: revoke every live token of the user (AC-23). Returns the count. */
  async revokeForUser(userId: string, now: Date, tx?: IdentityExecutor): Promise<number> {
    const rows = await execOf(this.db, tx)
      .update(t.apiTokens)
      .set({ revokedAt: now })
      .where(and(eq(t.apiTokens.userId, userId), isNull(t.apiTokens.revokedAt)))
      .returning({ id: t.apiTokens.id });
    return rows.length;
  }

  /** Record use (callers throttle to one write per TOUCH_THROTTLE_MS). */
  async touch(tokenId: string, at: Date, tx?: IdentityExecutor): Promise<void> {
    await execOf(this.db, tx)
      .update(t.apiTokens)
      .set({ lastUsedAt: at })
      .where(eq(t.apiTokens.id, tokenId));
  }
}
