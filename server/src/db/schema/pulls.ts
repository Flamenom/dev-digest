import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { workspaces } from './core';
import { repos } from './repos';

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    author: text('author').notNull(),
    branch: text('branch').notNull(),
    base: text('base').notNull(),
    headSha: text('head_sha').notNull(),
    lastReviewedSha: text('last_reviewed_sha'),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    filesCount: integer('files_count').notNull().default(0),
    status: text('status').notNull().default('needs_review'),
    body: text('body'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    // Migration 0019 (GitLab support) — all nullable so pre-existing rows survive.
    /** Draft / WIP flag from the host; null = unknown (rows written before 0019). */
    isDraft: boolean('is_draft'),
    /** False when the host list payload carried no diff stats (additions/deletions are placeholders). */
    statsKnown: boolean('stats_known'),
    /** head_sha the stored files/commits detail was fetched at (head-unchanged short-circuit). */
    detailHeadSha: text('detail_head_sha'),
  },
  (t) => ({
    uq: uniqueIndex('pr_repo_number_uq').on(t.repoId, t.number), // idempotent import
    wsIdx: index('pr_ws_idx').on(t.workspaceId),
  }),
);

export const prFiles = pgTable(
  'pr_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prId: uuid('pr_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    patch: text('patch'),
    // Migration 0019 (GitLab support) — nullable, so GitHub rows are unaffected.
    /** Old path for renamed files. */
    previousPath: text('previous_path'),
    /** Text + CHECK (migration 0020), not a pg enum. NULL = unknown. */
    changeType: text('change_type', { enum: ['added', 'modified', 'deleted', 'renamed'] }),
    /** Why `patch` is null (host omitted the diff). Text + CHECK (migration 0020). */
    patchOmitted: text('patch_omitted', { enum: ['too_large', 'collapsed'] }),
  },
  (t) => ({
    changeTypeCk: check(
      'pr_files_change_type_ck',
      sql`${t.changeType} in ('added', 'modified', 'deleted', 'renamed')`,
    ),
    patchOmittedCk: check(
      'pr_files_patch_omitted_ck',
      sql`${t.patchOmitted} in ('too_large', 'collapsed')`,
    ),
  }),
);

export const prCommits = pgTable('pr_commits', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  sha: text('sha').notNull(),
  message: text('message').notNull(),
  author: text('author').notNull(),
  committedAt: timestamp('committed_at', { withTimezone: true }),
});
