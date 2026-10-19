import type { ActorDirectory, ActorRefValue } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import { UsersRepo, type IdentityTx } from './repository/users.repo.js';
import { MembershipsRepo } from './repository/memberships.repo.js';
import { SessionsRepo } from './repository/sessions.repo.js';
import { OAuthFlowsRepo } from './repository/oauth-flows.repo.js';
import { ApiTokensRepo } from './repository/api-tokens.repo.js';
import { EXPIRED_SWEEP_BATCH } from './constants.js';

/**
 * Identity data access (multi-user server mode): users, memberships,
 * sessions, OIDC flows and personal API tokens. The ONLY layer touching these
 * tables. Query implementations are colocated per aggregate under
 * `./repository/`; this facade composes them and exports DOMAIN types only —
 * no `$inferSelect` row type crosses this boundary.
 *
 * Every method takes an optional `tx` so services own transaction boundaries
 * (`transaction` / `withWorkspaceLock`); the repositories never open one,
 * except `upsertBySub`'s savepoint retry and the lock helper itself.
 *
 * Secrets discipline: session ids, OAuth `state` and API token values are
 * passed in already HASHED (`sha256Hex`); raw values never reach this layer.
 */
export class IdentityRepository implements ActorDirectory {
  readonly users: UsersRepo;
  readonly memberships: MembershipsRepo;
  readonly sessions: SessionsRepo;
  readonly oauthFlows: OAuthFlowsRepo;
  readonly apiTokens: ApiTokensRepo;

  constructor(private db: Db) {
    this.users = new UsersRepo(db);
    this.memberships = new MembershipsRepo(db);
    this.sessions = new SessionsRepo(db);
    this.oauthFlows = new OAuthFlowsRepo(db);
    this.apiTokens = new ApiTokensRepo(db);
  }

  /** `ActorDirectory` — an arrow property so it can be passed around unbound. */
  readonly lookup = (ids: readonly string[]): Promise<Map<string, ActorRefValue>> =>
    this.users.lookupActors(ids);

  /**
   * Periodic maintenance (google mode): delete one bounded batch each of
   * expired OIDC flows and expired (absolute or idle) sessions.
   */
  async sweepExpired(now: Date, limit = EXPIRED_SWEEP_BATCH): Promise<{ oauthFlows: number; sessions: number }> {
    const oauthFlows = await this.oauthFlows.sweepExpired(now, limit);
    const sessions = await this.sessions.sweepExpired(now, { limit, idle: true });
    return { oauthFlows, sessions };
  }

  /** Run `fn` in one transaction (e.g. deactivate + revoke sessions/tokens + audit). */
  transaction<T>(fn: (tx: IdentityTx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /** One transaction holding the workspace membership lock (last-admin guard, sign-in). */
  withWorkspaceLock<T>(workspaceId: string, fn: (tx: IdentityTx) => Promise<T>): Promise<T> {
    return this.memberships.withWorkspaceLock(workspaceId, fn);
  }
}

export type { IdentityTx, IdentityExecutor, IdentityUser, UserClaims, UpsertUserResult } from './repository/users.repo.js';
export type { Membership, MemberListing, EnsureMemberResult } from './repository/memberships.repo.js';
export type { NewSession, SessionRecord, ActiveSession } from './repository/sessions.repo.js';
export type { NewOAuthFlow, OAuthFlow } from './repository/oauth-flows.repo.js';
export type {
  NewApiToken,
  ApiTokenRecord,
  ActiveApiToken,
} from './repository/api-tokens.repo.js';
export { UsersRepo, MembershipsRepo, SessionsRepo, OAuthFlowsRepo, ApiTokensRepo };
