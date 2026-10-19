import { eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import { OAUTH_FLOW_TTL_MS } from '../constants.js';
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

  async create(input: NewOAuthFlow, tx?: IdentityExecutor): Promise<void> {
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
}
