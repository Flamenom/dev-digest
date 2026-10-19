import {
  ApiTokenCreateInput,
  type ApiTokenCreated,
  type ApiTokenListItem,
  type AuditLog,
  type Clock,
  type Principal,
} from '@devdigest/shared';
import type { z } from 'zod';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
import {
  ForbiddenOwnerError,
  SessionRequiredError,
  TokenLimitError,
} from '../../platform/auth-errors.js';
import { newApiToken, type NewApiToken } from '../../platform/crypto/tokens.js';
import { TOKEN_LIMIT } from './constants.js';
import type {
  ApiTokenRecord,
  ApiTokensRepo,
  IdentityRepository,
  IdentityTx,
} from './repository.js';

/**
 * Personal API tokens (spec SPEC-2026-10-19-multi-user-server, AC-55–AC-58).
 *
 * Secrets discipline: the token VALUE exists only in `create`'s return value —
 * it is never persisted (only its sha256), logged, audited or listed again.
 * Audit metadata carries `token_id` / `token_name` only.
 *
 * Tokens act with the owner's CURRENT role (resolved per request by the
 * principal service) and can never manage tokens themselves — the route
 * policy enforces session-only; the `via` check here is defense in depth.
 */

/** The structural slice of {@link IdentityRepository} this service needs. */
export interface TokensIdentityPort {
  apiTokens: Pick<ApiTokensRepo, 'create' | 'findById' | 'listForUser' | 'countActive' | 'revoke'>;
  transaction: IdentityRepository['transaction'];
  withWorkspaceLock: IdentityRepository['withWorkspaceLock'];
}

export interface TokensServiceDeps {
  identity: TokensIdentityPort;
  audit: AuditLog<IdentityTx>;
  clock: Clock;
  /** Token generator seam for tests; defaults to the CSPRNG `newApiToken`. */
  generate?: () => NewApiToken;
}

export type TokenActor = Pick<Principal, 'userId' | 'workspaceId' | 'role'> & {
  via?: Principal['via'];
  ip?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function toListItem(r: ApiTokenRecord): ApiTokenListItem {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    created_at: r.createdAt.toISOString(),
    last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    expires_at: r.expiresAt.toISOString(),
  };
}

export class TokensService {
  constructor(private deps: TokensServiceDeps) {}

  /**
   * Mint a token for the actor (AC-55). Name 1–64 chars (trimmed), expiry
   * 1–365 days, default 90 — validated against the contract here too. More
   * than {@link TOKEN_LIMIT} active tokens → `TokenLimitError` (AC-58); the
   * count + insert run under the workspace lock so concurrent creates can't
   * overshoot the limit.
   */
  async create(
    actor: TokenActor,
    input: z.input<typeof ApiTokenCreateInput>,
  ): Promise<ApiTokenCreated> {
    if (actor.via === 'token') throw new SessionRequiredError();
    const parsed = ApiTokenCreateInput.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError('Invalid token request', parsed.error.issues);
    }
    const { name, expires_in_days } = parsed.data;
    const { identity, audit, clock } = this.deps;
    const generate = this.deps.generate ?? newApiToken;
    const ws = actor.workspaceId;

    return identity.withWorkspaceLock(ws, async (tx) => {
      const now = clock.now();
      const active = await identity.apiTokens.countActive(ws, actor.userId, now, tx);
      if (active >= TOKEN_LIMIT) throw new TokenLimitError(TOKEN_LIMIT);

      const token = generate();
      const record = await identity.apiTokens.create(
        {
          userId: actor.userId,
          workspaceId: ws,
          name,
          tokenHash: token.hash,
          prefix: token.prefix,
          now,
          expiresAt: new Date(now.getTime() + expires_in_days * DAY_MS),
        },
        tx,
      );
      await audit.record(
        {
          workspaceId: ws,
          actorUserId: actor.userId,
          action: 'token.create',
          targetType: 'api_token',
          targetId: record.id,
          metadata: { token_id: record.id, token_name: record.name },
          ip: actor.ip ?? null,
        },
        tx,
      );
      return {
        id: record.id,
        name: record.name,
        token: token.value,
        prefix: record.prefix,
        created_at: record.createdAt.toISOString(),
        expires_at: record.expiresAt.toISOString(),
      };
    });
  }

  /** The actor's own unrevoked tokens, newest first — a bare array (GET /tokens). */
  async list(actor: TokenActor): Promise<ApiTokenListItem[]> {
    const rows = await this.deps.identity.apiTokens.listForUser(actor.workspaceId, actor.userId);
    return rows.map(toListItem);
  }

  /**
   * Revoke one token: the owner, or any Admin (AC-30). Unknown / already
   * revoked → `NotFoundError`; someone else's token as a Member →
   * `ForbiddenOwnerError`.
   */
  async revoke(actor: TokenActor, tokenId: string): Promise<void> {
    if (actor.via === 'token') throw new SessionRequiredError();
    const { identity, audit, clock } = this.deps;
    const ws = actor.workspaceId;

    await identity.transaction(async (tx) => {
      const record = await identity.apiTokens.findById(ws, tokenId, tx);
      if (!record || record.revokedAt) throw new NotFoundError('Token not found');
      if (record.userId !== actor.userId && actor.role !== 'admin') {
        throw new ForbiddenOwnerError();
      }
      const revoked = await identity.apiTokens.revoke(ws, record.id, clock.now(), tx);
      if (!revoked) throw new NotFoundError('Token not found');
      await audit.record(
        {
          workspaceId: ws,
          actorUserId: actor.userId,
          action: 'token.revoke',
          targetType: 'api_token',
          targetId: record.id,
          metadata: { token_id: record.id, token_name: record.name },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
  }
}
