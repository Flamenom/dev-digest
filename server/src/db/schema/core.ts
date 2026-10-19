import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { now } from './_shared';

// ============================================================ Tenancy & core

/**
 * Partial-index predicate of `users_google_lower_email_uq` (migration 0021). The
 * single source for the schema index below and any `ON CONFLICT … WHERE …`
 * arbiter a repository may write against it (same pattern as `reposIdentityWhere`).
 */
export const usersGoogleIdentityWhere = (googleSub: AnyPgColumn): SQL =>
  sql`${googleSub} is not null`;

/** Workspace roles (migration 0021 mapped the legacy `owner` value to `admin`). */
export const MEMBER_ROLES = ['admin', 'member'] as const;
/** Membership lifecycle. A deactivated member can't sign in; sessions/tokens are revoked. */
export const MEMBER_STATUSES = ['active', 'deactivated'] as const;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    createdAt: now(),
    /** Google OIDC `sub` — the stable identity key in google mode; null for the local system user. */
    googleSub: text('google_sub'),
    avatarUrl: text('avatar_url'),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  },
  (t) => ({
    /** Upsert arbiter for sign-in (`ON CONFLICT (google_sub)`); NULLs stay distinct. */
    googleSubUq: uniqueIndex('users_google_sub_uq').on(t.googleSub),
    /** Google-identified users are unique by case-insensitive email. */
    googleEmailUq: uniqueIndex('users_google_lower_email_uq')
      .on(sql`lower(${t.email})`)
      .where(usersGoogleIdentityWhere(t.googleSub)),
  }),
);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: now(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MEMBER_ROLES }).notNull().default('member'),
    status: text('status', { enum: MEMBER_STATUSES }).notNull().default('active'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusChangedBy: uuid('status_changed_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    /** Null for memberships created before migration 0021 (DTO falls back to users.created_at). */
    joinedAt: timestamp('joined_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
    /** FK index: ON DELETE SET NULL from users. */
    statusChangedByIdx: index('workspace_members_status_changed_by_idx').on(t.statusChangedBy),
    roleCk: check('workspace_members_role_ck', sql`${t.role} in ('admin', 'member')`),
    statusCk: check(
      'workspace_members_status_ck',
      sql`${t.status} in ('active', 'deactivated')`,
    ),
  }),
);

/** Non-secret prefs/config. Secrets go via SecretsProvider, NOT here. */
export const settings = pgTable(
  'settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value'),
  },
  (t) => ({
    uq: uniqueIndex('settings_ws_user_key_uq').on(t.workspaceId, t.userId, t.key),
  }),
);
