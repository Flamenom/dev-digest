import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces, users } from './core';

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    type: text('type', { enum: ['rubric', 'convention', 'security', 'custom'] }).notNull(),
    source: text('source', {
      enum: ['manual', 'imported_url', 'extracted', 'community'],
    }).notNull(),
    body: text('body').notNull(),
    // Project docs (relative repo paths) attached to this skill's prompt injection.
    attachedDocPaths: jsonb('attached_doc_paths').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    evidenceFiles: jsonb('evidence_files').$type<string[]>(),
    createdAt: now(),
    /** Creator / last updater (migration 0021); null for skills created before it. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    createdByIdx: index('skills_created_by_idx').on(t.createdBy),
    updatedByIdx: index('skills_updated_by_idx').on(t.updatedBy),
  }),
);

export const skillVersions = pgTable(
  'skill_versions',
  {
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    /** Optional "what changed" note captured on body saves (L02). */
    note: text('note'),
    createdAt: now(),
    /** Version author (migration 0021); null for versions created before it. */
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skillId, t.version] }),
    authorIdx: index('skill_versions_author_idx').on(t.authorId),
  }),
);
