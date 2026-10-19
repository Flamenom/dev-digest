import { eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import { EXPIRED_SWEEP_BATCH, OAUTH_FLOW_TTL_MS } from '../constants.js';
import { execOf, type IdentityExecutor } from './users.repo.js';

// ---- Domain types -----------------------------------------------------------

export interface NewOAuthFlow {
  /** sha256 of the `state` sent to Google — the raw state is never stored. */
  stateHash: string;
  /** sha256 of the browser-binding cookie value the flow started with (AC-7). */
  bindingHash: string;
  nonce: string;
  codeVerifier: string;
  /** Already validated same-origin relative path (AC-16). */
  returnTo: string;
  /** Issue time (injected clock); expiry = now + OAUTH_FLOW_TTL_MS. */
  now: Date;
}

/** A consumed (deleted) flow, handed to the callback exactly once. */
export interface OAuthFlow {
  bindingHash: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
}

// ---- Repository -------------------------------------------------------------

/** `oauth_flows` data access — single-use OIDC authorization requests. */
export class OAuthFlowsRepo {
  constructor(private db: Db) {}

  /**
   * Persist a new flow. Every anonymous `/auth/google/start` inserts one and
   * only a callback consumes it, so abandoned flows are swept here first — a
   * bounded batch of already-expired rows (see {@link sweepExpired}).
   */
  async create(input: NewOAuthFlow, tx?: IdentityExecutor): Promise<void> {
    await this.sweepExpired(input.now, EXPIRED_SWEEP_BATCH, tx);
    await execOf(this.db, tx)
      .insert(t.oauthFlows)
      .values({
        stateHash: input.stateHash,
        bindingHash: input.bindingHash,
        nonce: input.nonce,
        codeVerifier: input.codeVerifier,
        returnTo: input.returnTo,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + OAUTH_FLOW_TTL_MS),
      });
  }

  /**
   * Take the flow for `stateHash` out of the store (`DELETE … RETURNING`, so a
   * replay finds nothing — AC-7). An expired flow is deleted too but yields
   * undefined. The DELETE is atomic: of two racing callbacks only one gets it.
   */
  async consume(stateHash: string, now: Date, tx?: IdentityExecutor): Promise<OAuthFlow | undefined> {
    const [row] = await execOf(this.db, tx)
      .delete(t.oauthFlows)
      .where(eq(t.oauthFlows.stateHash, stateHash))
      .returning({
        bindingHash: t.oauthFlows.bindingHash,
        nonce: t.oauthFlows.nonce,
        codeVerifier: t.oauthFlows.codeVerifier,
        returnTo: t.oauthFlows.returnTo,
        createdAt: t.oauthFlows.createdAt,
        expiresAt: t.oauthFlows.expiresAt,
      });
    if (!row || row.expiresAt.getTime() <= now.getTime()) return undefined;
    return row;
  }

  /**
   * Delete up to `limit` flows that expired before `now` (abandoned sign-ins).
   * The `id IN (SELECT … LIMIT n)` form bounds the work and walks
   * `oauth_flows_expires_at_idx`. Returns the number of rows deleted.
   */
  async sweepExpired(now: Date, limit: number = EXPIRED_SWEEP_BATCH, tx?: IdentityExecutor): Promise<number> {
    const exec = execOf(this.db, tx);
    const expired = exec
      .select({ id: t.oauthFlows.id })
      .from(t.oauthFlows)
      .where(lt(t.oauthFlows.expiresAt, now))
      .limit(limit);
    const rows = await exec
      .delete(t.oauthFlows)
      .where(inArray(t.oauthFlows.id, expired))
      .returning({ id: t.oauthFlows.id });
    return rows.length;
  }
}
