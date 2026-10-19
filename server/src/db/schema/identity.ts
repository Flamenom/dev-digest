import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
  customType,
} from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces, users } from './core';

// ============================================================ Identity, sessions, secrets, audit
// Multi-user server mode (migration 0021). Every secret-ish value here is stored
// HASHED (session ids, oauth state, api tokens) or ENCRYPTED (encrypted_secrets);
// raw values never reach the database.

/** Postgres `bytea` ↔ Node `Buffer` (drizzle-orm 0.38 has no built-in bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Postgres `inet` ↔ string (drizzle-orm 0.38 has no built-in inet column). The
 * repository normalises to a valid IPv4/IPv6 literal (or null) before insert, so
 * the cast never fails at the database.
 */
const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});

/** Server-side sessions. The cookie carries the raw id; only its SHA-256 is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idHash: text('id_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: now(),
    /** Idle-timeout clock; touched at most once per throttle window. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    /** Absolute expiry (created_at + absolute lifetime). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    idHashUq: uniqueIndex('sessions_id_hash_uq').on(t.idHash),
    /** Deactivation / sign-out-everywhere: `delete … where user_id = ?`. */
    userIdx: index('sessions_user_idx').on(t.userId),
    /** FK index: workspace-cascade deletes + per-workspace session sweeps. */
    workspaceIdx: index('sessions_workspace_idx').on(t.workspaceId),
    /** Future expiry sweep (`delete … where expires_at < now()`). */
    expiresIdx: index('sessions_expires_at_idx').on(t.expiresAt),
    // Deliberately NO index on last_seen_at: it is written on the request path
    // (touch), and an index on it would defeat HOT updates. The idle sweep runs
    // only on the periodic timer as a LIMIT-bounded scan (sessions.repo.ts).
  }),
);

/** In-flight OIDC authorization requests — single use (consumed by DELETE … RETURNING). */
export const oauthFlows = pgTable(
  'oauth_flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stateHash: text('state_hash').notNull(),
    /** Hash of the browser-binding cookie value the flow was started with. */
    bindingHash: text('binding_hash').notNull(),
    nonce: text('nonce').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    returnTo: text('return_to').notNull().default('/'),
    createdAt: now(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    stateHashUq: uniqueIndex('oauth_flows_state_hash_uq').on(t.stateHash),
    /** Future expiry sweep of abandoned flows. */
    expiresIdx: index('oauth_flows_expires_at_idx').on(t.expiresAt),
  }),
);

/** Personal API tokens (bearer auth for the MCP server). Only the hash + display prefix are stored. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    createdAt: now(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    tokenHashUq: uniqueIndex('api_tokens_token_hash_uq').on(t.tokenHash),
    /** FK index: user-cascade deletes (the partial index below only covers active tokens). */
    userIdx: index('api_tokens_user_idx').on(t.userId),
    /** Own-token list + the active-token limit count. */
    userActiveIdx: index('api_tokens_user_active_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
    /** FK index: workspace-cascade deletes. */
    workspaceIdx: index('api_tokens_workspace_idx').on(t.workspaceId),
    nameLenCk: check('api_tokens_name_len_ck', sql`char_length(${t.name}) between 1 and 64`),
  }),
);

/**
 * Provider tokens / LLM keys in google mode: AES-256-GCM ciphertext + 96-bit
 * nonce, AAD = workspace + key name. `key_id` is a non-reversible fingerprint of
 * the master key that sealed the row (rotation detection), never the key itself.
 */
export const encryptedSecrets = pgTable(
  'encrypted_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    keyName: text('key_name').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    keyId: text('key_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    /** Upsert arbiter (`ON CONFLICT (workspace_id, key_name)`). */
    wsKeyUq: uniqueIndex('encrypted_secrets_ws_key_uq').on(t.workspaceId, t.keyName),
    /** FK index: ON DELETE SET NULL from users. */
    updatedByIdx: index('encrypted_secrets_updated_by_idx').on(t.updatedBy),
    /** Master-key rotation scan (`listByKeyId`: rows sealed by a given key). */
    keyIdIdx: index('encrypted_secrets_key_id_idx').on(t.keyId),
    nonceLenCk: check('encrypted_secrets_nonce_len_ck', sql`octet_length(${t.nonce}) = 12`),
  }),
);

/**
 * Append-only audit trail. A BEFORE UPDATE OR DELETE row trigger (migration 0021)
 * and a BEFORE TRUNCATE statement trigger (migration 0023) raise, so rows can
 * only be inserted. `actor_user_id` is deliberately a soft
 * reference (no FK): an FK action would have to UPDATE/DELETE audit rows, which
 * the trigger forbids, and the trail must outlive any user row. The workspace FK
 * has no ON DELETE action for the same reason (deleting an audited workspace is
 * refused). Null actor = rejected sign-in / system action.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: inet('ip'),
    createdAt: now(),
  },
  (t) => ({
    wsCreatedIdx: index('audit_events_ws_created_idx').on(t.workspaceId, t.createdAt),
    metadataObjectCk: check('audit_events_metadata_object_ck', sql`jsonb_typeof(${t.metadata}) = 'object'`),
  }),
);
