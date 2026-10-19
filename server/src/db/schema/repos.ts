import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces, users } from './core';

export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    /**
     * Code host (migration 0019). TEXT + CHECK, not a pg enum — the provider set
     * is expected to grow. Existing rows backfill to github / github.com.
     * `web_url` is derived (`https://<host>/<full_name>`), never stored.
     */
    provider: text('provider', { enum: ['github', 'gitlab'] }).notNull().default('github'),
    host: text('host').notNull().default('github.com'),
    defaultBranch: text('default_branch').notNull().default('main'),
    clonePath: text('clone_path'),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    /** PR-list sync bookkeeping (sync-on-open): last success, last attempt, last error. */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: now(),
  },
  (t) => ({
    /**
     * Repo identity is provider-specific, so it is split into two DISJOINT partial
     * unique indexes (migration 0020) — every insert has exactly one arbiter index,
     * which keeps `ON CONFLICT … DO NOTHING` race-safe (see RepoRepository.insert):
     *   - non-GitLab (GitHub): exact (workspace, provider, host, full_name);
     *   - GitLab: case-insensitive on full_name — agrees with the app's
     *     `lower(full_name)` dedupe lookup (gitlab.com paths are case-insensitive).
     * The same path may exist on two hosts.
     */
    uq: uniqueIndex('repos_ws_provider_host_fullname_uq')
      .on(t.workspaceId, t.provider, t.host, t.fullName)
      .where(sql`${t.provider} <> 'gitlab'`),
    gitlabUq: uniqueIndex('repos_gitlab_ws_host_lower_fullname_uq')
      .on(t.workspaceId, t.provider, t.host, sql`lower(${t.fullName})`)
      .where(sql`${t.provider} = 'gitlab'`),
    providerCk: check('repos_provider_ck', sql`${t.provider} in ('github', 'gitlab')`),
    /** Hosts are stored canonical (lower-case) so identity comparisons stay exact. */
    hostLowerCk: check('repos_host_lower_ck', sql`${t.host} = lower(${t.host})`),
    wsIdx: index('repos_ws_idx').on(t.workspaceId),
  }),
);
