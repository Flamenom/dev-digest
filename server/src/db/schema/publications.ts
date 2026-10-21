import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  PublicationStatus,
  PublicationItemState,
  PublishAnchorKind,
} from '@devdigest/shared';
import { now } from './_shared';
import { workspaces, users } from './core';
import { pullRequests } from './pulls';
import { reviews, findings } from './reviews';

// ============================================================ Review publications
// Publish review findings to a GitLab MR as one batch review (migration 0027,
// spec `specs/2026-10-21-gitlab-publish-findings.md`). Ids, counters, codes and
// fixed server messages only — no note body, no summary, no token is ever stored.

/**
 * Literal lists of the contract enums. A VALUE import of `@devdigest/shared` is
 * impossible here: drizzle-kit loads the schema through its own CJS loader, which
 * cannot resolve the vendored barrel's `./x.js` → `.ts` specifiers. Drift is
 * prevented twice instead: `enumList` below fails typecheck when a list misses a
 * member of its contract union (or holds a foreign one), and
 * `review-publications-schema.it.test.ts` asserts equality with the contract's
 * `PublicationStatus.options` etc. at runtime.
 */
const enumList =
  <U extends string>() =>
  <const T extends readonly U[]>(
    values: T & ([U] extends [T[number]] ? unknown : { missing: Exclude<U, T[number]> }),
  ): T =>
    values;

export const PUBLICATION_STATUSES = enumList<PublicationStatus>()([
  'in_progress',
  'published',
  'partially_published',
  'failed',
  'unconfirmed',
]);
export const PUBLICATION_ITEM_STATES = enumList<PublicationItemState>()([
  'pending',
  'drafted',
  'published',
  'failed',
  'rolled_back',
]);
export const PUBLISH_ANCHOR_KINDS = enumList<PublishAnchorKind>()([
  'multi_line',
  'single_line',
  'general',
]);

/** `a in ('x','y',…)` from a contract's literal list, so schema and contract cannot drift. */
const inList = (col: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${col} in (${sql.join(
    values.map((v) => sql.raw(`'${v.replace(/'/g, "''")}'`)),
    sql`, `,
  )})`;

/** Statuses a publication finishes in (must carry `finished_at`). `unconfirmed` is NOT terminal. */
const TERMINAL_STATUSES = ['published', 'partially_published', 'failed'] as const;

/** Item states that hold a finding "live" — at most one per finding (AC-35). */
const LIVE_ITEM_STATES = ['pending', 'drafted', 'published'] as const;

export const reviewPublications = pgTable(
  'review_publications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    prId: uuid('pr_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    status: text('status', { enum: PUBLICATION_STATUSES })
      .notNull()
      .default('in_progress'),
    /** A `PublishErrorCode` (or reused code) — never a body. */
    code: text('code'),
    /** A fixed server message — never user/finding text. */
    message: text('message'),
    requested: integer('requested').notNull(),
    drafted: integer('drafted').notNull().default(0),
    published: integer('published').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    generalNotes: integer('general_notes').notNull().default(0),
    applicableSuggestions: integer('applicable_suggestions').notNull().default(0),
    otherDraftsPublished: integer('other_drafts_published').notNull().default(0),
    hasSummary: boolean('has_summary').notNull(),
    applySuggestions: boolean('apply_suggestions').notNull().default(false),
    /** The MR diff-refs head the positioned drafts were sent against (ids only). */
    diffHeadSha: text('diff_head_sha'),
    bulkPublishSentAt: timestamp('bulk_publish_sent_at', { withTimezone: true }),
    createdAt: now(),
    /** Heartbeat — drives the 10-minute stale rule of the reconciler (AC-34). */
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    statusCk: check('review_publications_status_ck', inList(t.status, PUBLICATION_STATUSES)),
    countersCk: check(
      'review_publications_counters_ck',
      sql`${t.drafted} >= 0 and ${t.published} >= 0 and ${t.failed} >= 0 and ${t.generalNotes} >= 0 and ${t.applicableSuggestions} >= 0 and ${t.otherDraftsPublished} >= 0`,
    ),
    requestedCk: check('review_publications_requested_ck', sql`${t.requested} between 1 and 50`),
    totalsCk: check(
      'review_publications_totals_ck',
      sql`${t.published} + ${t.failed} <= ${t.requested}`,
    ),
    /** Terminal statuses must be finished; `in_progress` / `unconfirmed` may not be. */
    finishedCk: check(
      'review_publications_finished_ck',
      sql`not (${inList(t.status, TERMINAL_STATUSES)}) or ${t.finishedAt} is not null`,
    ),
    /** AC-22 — at most one in-progress publication per PR, race-proof at the DB. */
    prInProgressUq: uniqueIndex('review_publications_pr_in_progress_uq')
      .on(t.prId)
      .where(sql`${t.status} = 'in_progress'`),
    /** `GET /reviews/:id/publications` — newest first. */
    reviewCreatedIdx: index('review_publications_review_created_idx').on(
      t.reviewId,
      t.createdAt.desc(),
    ),
    /** Boot + preview reconcile scans. */
    reconcileIdx: index('review_publications_reconcile_idx')
      .on(t.status, t.updatedAt)
      .where(sql`${t.status} in ('in_progress', 'unconfirmed')`),
    /** FK index: workspace-cascade deletes. */
    workspaceIdx: index('review_publications_workspace_idx').on(t.workspaceId),
    /** FK index: user `set null` on delete. */
    createdByIdx: index('review_publications_created_by_idx').on(t.createdBy),
    /** FK index: PR-cascade deletes + the per-PR reconcile lookup (the partial unique covers in_progress only). */
    prIdx: index('review_publications_pr_idx').on(t.prId),
  }),
);

export const reviewPublicationItems = pgTable(
  'review_publication_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** FK declared below with an explicit name (the generated one exceeds 63 chars). */
    publicationId: uuid('publication_id').notNull(),
    findingId: uuid('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    /** Send order (severity, file, line). */
    position: integer('position').notNull(),
    state: text('state', { enum: PUBLICATION_ITEM_STATES }).notNull().default('pending'),
    code: text('code'),
    anchorKind: text('anchor_kind', { enum: PUBLISH_ANCHOR_KINDS }).notNull(),
    draftId: bigint('draft_id', { mode: 'number' }),
    discussionId: text('discussion_id'),
    noteId: bigint('note_id', { mode: 'number' }),
    url: text('url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => ({
    publicationFk: foreignKey({
      name: 'review_publication_items_publication_fk',
      columns: [t.publicationId],
      foreignColumns: [reviewPublications.id],
    }).onDelete('cascade'),
    stateCk: check('review_publication_items_state_ck', inList(t.state, PUBLICATION_ITEM_STATES)),
    anchorKindCk: check(
      'review_publication_items_anchor_kind_ck',
      inList(t.anchorKind, PUBLISH_ANCHOR_KINDS),
    ),
    urlCk: check(
      'review_publication_items_url_ck',
      sql`${t.url} is null or ${t.url} like 'https://%'`,
    ),
    publicationFindingUq: uniqueIndex('review_publication_items_publication_finding_uq').on(
      t.publicationId,
      t.findingId,
    ),
    /**
     * AC-35 — a finding has at most one live row, so it is never drafted twice
     * nor published twice. Rows of an `unconfirmed` publication stay `drafted`
     * and keep blocking (AC-33).
     */
    findingLiveUq: uniqueIndex('review_publication_items_finding_live_uq')
      .on(t.findingId)
      .where(inList(t.state, LIVE_ITEM_STATES)),
    /** FK index: finding-cascade deletes + all-state finding lookups (the partial unique covers live rows only). */
    findingIdx: index('review_publication_items_finding_idx').on(t.findingId),
    publicationPositionIdx: index('review_publication_items_publication_position_idx').on(
      t.publicationId,
      t.position,
    ),
  }),
);
