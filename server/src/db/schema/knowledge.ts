import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  doublePrecision,
  boolean,
  integer,
  vector,
  index,
} from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces } from './core';
import { repos } from './repos';

// ============================================================ Knowledge / RAG

export const memory = pgTable(
  'memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['repo', 'global', 'team'] }).notNull(),
    kind: text('kind', {
      enum: ['decision', 'convention', 'preference', 'fact', 'learning'],
    }).notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    confidence: doublePrecision('confidence'),
    sources: jsonb('sources'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({ wsIdx: index('memory_ws_idx').on(t.workspaceId) }),
);

export const conventions = pgTable(
  'conventions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    rule: text('rule').notNull(),
    evidencePath: text('evidence_path'),
    evidenceSnippet: text('evidence_snippet'),
    confidence: doublePrecision('confidence'),
    // Kept in lockstep with `status` ('accepted' ⇔ true) for the frozen
    // ConventionCandidate contract; new code reads/writes `status`.
    accepted: boolean('accepted').notNull().default(false),
    category: text('category', {
      enum: [
        'naming',
        'structure',
        'imports',
        'error-handling',
        'typing',
        'testing',
        'styling',
        'api-design',
        'other',
      ],
    })
      .notNull()
      .default('other'),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] })
      .notNull()
      .default('pending'),
    evidenceStartLine: integer('evidence_start_line'),
    evidenceEndLine: integer('evidence_end_line'),
    createdAt: now(),
  },
  (t) => ({
    repoIdx: index('conventions_repo_idx').on(t.repoId),
    wsIdx: index('conventions_ws_idx').on(t.workspaceId),
  }),
);

// One row per repo (upsert on repo_id): scan meta must survive scans whose
// candidates were all dropped or later replaced by a re-scan.
export const conventionsScans = pgTable('conventions_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  repoId: uuid('repo_id')
    .notNull()
    .unique()
    .references(() => repos.id, { onDelete: 'cascade' }),
  sampledFileCount: integer('sampled_file_count').notNull(),
  droppedCount: integer('dropped_count').notNull().default(0),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).defaultNow().notNull(),
});
