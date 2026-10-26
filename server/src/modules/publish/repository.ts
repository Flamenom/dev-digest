/**
 * Publish repository — `review_publications` + `review_publication_items`
 * (migration 0027; spec `specs/2026-10-21-gitlab-publish-findings.md`, plan T7).
 *
 * Infrastructure ring: the ONLY place the publish module runs queries. It
 * implements the consumer-shaped `PublishStore` port (ports.ts), maps every row
 * to a domain type (repository/mappers.ts) and translates Postgres constraint
 * violations into the domain errors `PublishInProgressError` (AC-22) and
 * `FindingAlreadyPublishedError` (AC-35) — a `PostgresError` never escapes.
 *
 * The lock and the dedupe are the DB's partial unique indexes, not an
 * application check, so they hold under concurrent requests. Violations are
 * caught (not `ON CONFLICT`: a partial index can't be an arbiter without its
 * predicate, see server INSIGHTS on `reposIdentityWhere`).
 *
 * Transactions: multi-statement operations use `db.transaction`, which becomes a
 * SAVEPOINT when the repository is bound to a caller's transaction via
 * {@link PublishRepository.withTx} — so a service can still compose several
 * calls in one outer transaction.
 */
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { hostRepoRef, repoWebUrl, type PublicationStatus } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import { PUBLISH_UNCONFIRMED_MESSAGE } from './codes.js';
import {
  FindingAlreadyPublishedError,
  PublishInProgressError,
  type CreatePublicationInput,
  type FindingLiveState,
  type FinishPublicationPatch,
  type MarkItemDraftedOptions,
  type PublicationAnchorResolution,
  type PublicationItemAnchorKind,
  type PublicationRecord,
  type PublicationStartDecision,
  type PublishedItemLink,
  type PublishReviewContext,
  type PublishStore,
} from './ports.js';
import {
  toActor,
  toFindingRow,
  toPersistedFile,
  toPrStatus,
  toPublicationRecord,
  toPublicationStatus,
  type PublicationItemRow,
  type PublicationRow,
} from './repository/mappers.js';
import {
  FINDING_LIVE_UQ,
  PR_IN_PROGRESS_UQ,
  uniqueViolationConstraint,
} from './repository/pg-errors.js';

/** The handle Drizzle passes to a `db.transaction(async (tx) => …)` callback. */
export type PublishTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Item states that hold a finding "live" (mirrors the AC-35 partial index predicate). */
const LIVE_STATES = ['pending', 'drafted', 'published'] as const;

/** Statuses that require `finished_at` (DB CHECK `review_publications_finished_ck`). */
const TERMINAL: ReadonlySet<PublicationStatus> = new Set([
  'published',
  'partially_published',
  'failed',
]);

const PUBLISH_MAX_ITEMS = 50;

/** `updated_at = now()` — the AC-34 heartbeat, bumped by every progress write. */
const heartbeat = () => sql`now()`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id would make Postgres RAISE on a uuid column instead of matching nothing. */
const isUuid = (value: string): boolean => UUID_RE.test(value);

export class PublishRepository implements PublishStore {
  constructor(private readonly db: Db) {}

  /** The same repository bound to a caller-owned transaction (onion §5). */
  withTx(tx: PublishTx): PublishRepository {
    // A transaction exposes the same query builders as the client; the cast keeps
    // call sites free of a `Db | PgTransaction` union (identity/pulls repos do the same).
    return new PublishRepository(tx as unknown as Db);
  }

  // ---------------------------------------------------------------- reads

  loadReviewContext = async (
    workspaceId: string,
    reviewId: string,
  ): Promise<PublishReviewContext | null> => {
    if (!isUuid(workspaceId) || !isUuid(reviewId)) return null;
    const [row] = await this.db
      .select({ review: t.reviews, pr: t.pullRequests, repo: t.repos })
      .from(t.reviews)
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.reviews.prId))
      .innerJoin(t.repos, eq(t.repos.id, t.pullRequests.repoId))
      .where(
        and(
          eq(t.reviews.id, reviewId),
          eq(t.reviews.workspaceId, workspaceId),
          eq(t.pullRequests.workspaceId, workspaceId),
          eq(t.repos.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const { review, pr, repo } = row;

    const [findingRows, fileRows] = await Promise.all([
      this.db
        .select()
        .from(t.findings)
        .where(eq(t.findings.reviewId, review.id))
        .orderBy(asc(t.findings.file), asc(t.findings.startLine), asc(t.findings.id)),
      this.db
        .select()
        .from(t.prFiles)
        .where(eq(t.prFiles.prId, pr.id))
        .orderBy(asc(t.prFiles.path)),
    ]);

    const ref = hostRepoRef(repo);
    return {
      review: {
        id: review.id,
        workspaceId: review.workspaceId,
        prId: review.prId,
        headSha: review.headSha,
      },
      pr: {
        id: pr.id,
        number: pr.number,
        status: toPrStatus(pr.status),
        headSha: pr.headSha,
        detailHeadSha: pr.detailHeadSha,
      },
      repo: {
        provider: ref.provider,
        ref,
        webUrl: repoWebUrl(ref.provider, ref.host, ref.fullName),
      },
      findings: findingRows.map(toFindingRow),
      files: fileRows.map(toPersistedFile),
    };
  };

  findingStates = async (findingIds: readonly string[]): Promise<FindingLiveState[]> => {
    const ids = [...new Set(findingIds)].filter(isUuid);
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({
        item: t.reviewPublicationItems,
        publicationStatus: t.reviewPublications.status,
        createdBy: t.reviewPublications.createdBy,
        publicationDeprecated: t.reviewPublications.deprecated,
        userName: t.users.name,
      })
      .from(t.reviewPublicationItems)
      .innerJoin(
        t.reviewPublications,
        eq(t.reviewPublications.id, t.reviewPublicationItems.publicationId),
      )
      .leftJoin(t.users, eq(t.users.id, t.reviewPublications.createdBy))
      .where(
        and(
          inArray(t.reviewPublicationItems.findingId, ids),
          inArray(t.reviewPublicationItems.state, [...LIVE_STATES]),
        ),
      );
    return rows.flatMap(({ item, publicationStatus, createdBy, publicationDeprecated, userName }) => {
      const state = item.state;
      if (state !== 'pending' && state !== 'drafted' && state !== 'published') return [];
      return [
        {
          findingId: item.findingId,
          publicationId: item.publicationId,
          publicationStatus: toPublicationStatus(publicationStatus),
          state,
          discussionId: item.discussionId,
          noteId: item.noteId,
          url: item.url,
          publishedAt: item.publishedAt,
          publishedBy: toActor(createdBy, userName),
          publicationDeprecated,
        },
      ];
    });
  };

  inProgressForPr = async (prId: string): Promise<{ id: string; reviewId: string } | null> => {
    if (!isUuid(prId)) return null;
    const [row] = await this.db
      .select({ id: t.reviewPublications.id, reviewId: t.reviewPublications.reviewId })
      .from(t.reviewPublications)
      .where(and(eq(t.reviewPublications.prId, prId), eq(t.reviewPublications.status, 'in_progress')))
      .limit(1);
    return row ?? null;
  };

  getPublication = async (
    workspaceId: string,
    publicationId: string,
  ): Promise<PublicationRecord | null> => {
    if (!isUuid(workspaceId) || !isUuid(publicationId)) return null;
    const [rec] = await this.loadPublications(
      and(
        eq(t.reviewPublications.id, publicationId),
        eq(t.reviewPublications.workspaceId, workspaceId),
      ),
    );
    return rec ?? null;
  };

  listForReview = async (workspaceId: string, reviewId: string): Promise<PublicationRecord[]> => {
    if (!isUuid(workspaceId) || !isUuid(reviewId)) return [];
    return this.loadPublications(
      and(
        eq(t.reviewPublications.reviewId, reviewId),
        eq(t.reviewPublications.workspaceId, workspaceId),
      ),
    );
  };

  reconcileCandidates = async (filter: {
    prId?: string;
    staleBefore: Date;
  }): Promise<PublicationRecord[]> => {
    if (filter.prId !== undefined && !isUuid(filter.prId)) return [];
    // Shaped to hit the partial `(status, updated_at) where status in (…)` index.
    const due = or(
      eq(t.reviewPublications.status, 'unconfirmed'),
      and(
        eq(t.reviewPublications.status, 'in_progress'),
        lt(t.reviewPublications.updatedAt, filter.staleBefore),
      ),
    );
    return this.loadPublications(
      filter.prId === undefined ? due : and(due, eq(t.reviewPublications.prId, filter.prId)),
      'oldest',
    );
  };

  // ---------------------------------------------------------------- lock + insert

  createPublication = async (input: CreatePublicationInput): Promise<PublicationRecord> => {
    const n = input.items.length;
    if (n < 1 || n > PUBLISH_MAX_ITEMS) {
      throw new RangeError(`A publication holds 1–${PUBLISH_MAX_ITEMS} items (got ${n})`);
    }
    // Two attempts: if the lock holder finished between our violation and the
    // follow-up read, the PR is free again — try once more rather than report a
    // running publication that no longer exists.
    for (let attempt = 0; ; attempt++) {
      try {
        const id = await this.db.transaction(async (tx) => {
          const [pub] = await tx
            .insert(t.reviewPublications)
            .values({
              workspaceId: input.workspaceId,
              reviewId: input.reviewId,
              prId: input.prId,
              createdBy: input.createdBy,
              status: 'in_progress',
              requested: n,
              hasSummary: input.hasSummary,
              applySuggestions: input.applySuggestions,
            })
            .returning({ id: t.reviewPublications.id });
          await tx.insert(t.reviewPublicationItems).values(
            input.items.map((it) => ({
              publicationId: pub!.id,
              findingId: it.findingId,
              position: it.position,
              anchorKind: it.anchorKind,
              state: 'pending' as const,
            })),
          );
          return pub!.id;
        });
        const created = await this.getPublication(input.workspaceId, id);
        if (!created) throw new Error('publication vanished right after insert');
        return created;
      } catch (err) {
        const constraint = uniqueViolationConstraint(err);
        if (constraint === PR_IN_PROGRESS_UQ) {
          const running = await this.inProgressForPr(input.prId);
          if (running) throw new PublishInProgressError(running.id);
          if (attempt === 0) continue;
          throw new PublishInProgressError('');
        }
        if (constraint === FINDING_LIVE_UQ) {
          const requested = input.items.map((i) => i.findingId);
          const live = await this.findingStates(requested);
          const ids = [...new Set(live.map((s) => s.findingId))];
          throw new FindingAlreadyPublishedError(ids.length > 0 ? ids : requested);
        }
        throw err;
      }
    }
  };

  deletePublication = async (publicationId: string): Promise<void> => {
    if (!isUuid(publicationId)) return;
    await this.db.delete(t.reviewPublications).where(eq(t.reviewPublications.id, publicationId));
  };

  // ---------------------------------------------------------------- start decisions

  setStartDecision = async (
    publicationId: string,
    decision: PublicationStartDecision,
  ): Promise<void> => {
    if (!isUuid(publicationId)) return;
    await this.db.transaction(async (tx) => {
      await tx
        .update(t.reviewPublications)
        .set({
          // DB CHECK `review_publications_deprecation_ck`: deprecated ⇔ reason set.
          deprecated: decision.deprecationReason !== null,
          deprecationReason: decision.deprecationReason,
          updatedAt: heartbeat(),
        })
        .where(eq(t.reviewPublications.id, publicationId));
      await this.updateItemAnchorKinds(tx, publicationId, decision.items);
    });
  };

  setAnchorResolution = async (
    publicationId: string,
    resolution: PublicationAnchorResolution,
  ): Promise<void> => {
    if (!isUuid(publicationId)) return;
    await this.db.transaction(async (tx) => {
      await tx
        .update(t.reviewPublications)
        .set({
          reviewedVersionFound: resolution.reviewedVersionFound,
          diffHeadSha: resolution.diffHeadSha,
          updatedAt: heartbeat(),
        })
        .where(eq(t.reviewPublications.id, publicationId));
      await this.updateItemAnchorKinds(tx, publicationId, resolution.items);
    });
  };

  // ---------------------------------------------------------------- progress

  markItemDrafted = async (
    publicationId: string,
    findingId: string,
    draftId: number,
    opts: MarkItemDraftedOptions = {},
  ): Promise<void> => {
    await this.db.transaction(async (tx) => {
      const changed = await tx
        .update(t.reviewPublicationItems)
        .set({
          state: 'drafted',
          draftId,
          code: null,
          ...(opts.anchorKind !== undefined ? { anchorKind: opts.anchorKind } : {}),
        })
        .where(
          and(
            this.itemWhere(publicationId, findingId),
            eq(t.reviewPublicationItems.state, 'pending'),
          ),
        )
        .returning({ id: t.reviewPublicationItems.id });
      await tx
        .update(t.reviewPublications)
        .set({
          ...(changed.length > 0
            ? { drafted: sql`${t.reviewPublications.drafted} + ${changed.length}` }
            : {}),
          // AC-12: one general re-send after a rejected position. `general_notes`
          // is derived from the items' final anchor kinds at finish.
          ...(changed.length > 0 && opts.positionFallback
            ? {
                positionFallbacks: sql`${t.reviewPublications.positionFallbacks} + ${changed.length}`,
              }
            : {}),
          updatedAt: heartbeat(),
        })
        .where(eq(t.reviewPublications.id, publicationId));
    });
  };

  markItemFailed = async (
    publicationId: string,
    findingId: string,
    code: string,
  ): Promise<void> => {
    await this.db.transaction(async (tx) => {
      const changed = await tx
        .update(t.reviewPublicationItems)
        .set({ state: 'failed', code })
        .where(
          and(
            this.itemWhere(publicationId, findingId),
            inArray(t.reviewPublicationItems.state, ['pending', 'drafted']),
          ),
        )
        .returning({ id: t.reviewPublicationItems.id });
      await tx
        .update(t.reviewPublications)
        .set({
          ...(changed.length > 0
            ? { failed: sql`${t.reviewPublications.failed} + ${changed.length}` }
            : {}),
          updatedAt: heartbeat(),
        })
        .where(eq(t.reviewPublications.id, publicationId));
    });
  };

  markItemsPublished = async (
    publicationId: string,
    links: readonly PublishedItemLink[],
  ): Promise<void> => {
    if (links.length === 0) return;
    await this.db.transaction(async (tx) => {
      let changedCount = 0;
      for (const link of links) {
        const changed = await tx
          .update(t.reviewPublicationItems)
          .set({
            state: 'published',
            code: null,
            discussionId: link.discussionId,
            noteId: link.noteId,
            // https only (DB CHECK) — anything else is stored as "link unavailable".
            url: link.url && link.url.startsWith('https://') ? link.url : null,
            publishedAt: link.publishedAt,
          })
          .where(
            and(
              this.itemWhere(publicationId, link.findingId),
              inArray(t.reviewPublicationItems.state, ['pending', 'drafted']),
            ),
          )
          .returning({ id: t.reviewPublicationItems.id });
        changedCount += changed.length;
      }
      await tx
        .update(t.reviewPublications)
        .set({
          ...(changedCount > 0
            ? { published: sql`${t.reviewPublications.published} + ${changedCount}` }
            : {}),
          updatedAt: heartbeat(),
        })
        .where(eq(t.reviewPublications.id, publicationId));
    });
  };

  markItemsRolledBack = async (
    publicationId: string,
    findingIds: readonly string[],
  ): Promise<void> => {
    const ids = findingIds.filter(isUuid);
    if (!isUuid(publicationId) || ids.length === 0) return;
    await this.db.transaction(async (tx) => {
      await tx
        .update(t.reviewPublicationItems)
        .set({ state: 'rolled_back' })
        .where(
          and(
            eq(t.reviewPublicationItems.publicationId, publicationId),
            inArray(t.reviewPublicationItems.findingId, ids),
            // A published note is on the MR — never "un-publish" it (AC-35).
            inArray(t.reviewPublicationItems.state, ['pending', 'drafted']),
          ),
        );
      await tx
        .update(t.reviewPublications)
        .set({ updatedAt: heartbeat() })
        .where(eq(t.reviewPublications.id, publicationId));
    });
  };

  rollBackLeftoverFindings = async (
    publicationIds: readonly string[],
    findingIds: readonly string[],
  ): Promise<void> => {
    const pubs = [...new Set(publicationIds)].filter(isUuid);
    const ids = [...new Set(findingIds)].filter(isUuid);
    if (pubs.length === 0 || ids.length === 0) return;
    await this.db
      .update(t.reviewPublicationItems)
      .set({ state: 'rolled_back' })
      .where(
        and(
          inArray(t.reviewPublicationItems.publicationId, pubs),
          inArray(t.reviewPublicationItems.findingId, ids),
          inArray(t.reviewPublicationItems.state, ['pending', 'drafted']),
        ),
      );
  };

  setOtherDrafts = async (publicationId: string, count: number): Promise<void> => {
    await this.patchPublication(publicationId, { otherDraftsPublished: Math.max(0, count) });
  };

  setBulkPublishSent = async (publicationId: string, at: Date): Promise<void> => {
    await this.patchPublication(publicationId, { bulkPublishSentAt: at });
  };

  touch = async (publicationId: string): Promise<void> => {
    await this.patchPublication(publicationId, {});
  };

  // ---------------------------------------------------------------- transitions

  finish = async (
    publicationId: string,
    from: readonly PublicationStatus[],
    patch: FinishPublicationPatch,
  ): Promise<boolean> => {
    if (!isUuid(publicationId) || from.length === 0) return false;
    const terminal = TERMINAL.has(patch.status);
    const finishedAt = terminal ? (patch.finishedAt ?? new Date()) : null;
    const c = patch.counters ?? {};
    const rows = await this.db
      .update(t.reviewPublications)
      .set({
        status: patch.status,
        code: patch.code,
        message: patch.message,
        finishedAt,
        ...(c.drafted !== undefined ? { drafted: c.drafted } : {}),
        ...(c.published !== undefined ? { published: c.published } : {}),
        ...(c.failed !== undefined ? { failed: c.failed } : {}),
        ...(c.generalNotes !== undefined ? { generalNotes: c.generalNotes } : {}),
        ...(c.applicableSuggestions !== undefined
          ? { applicableSuggestions: c.applicableSuggestions }
          : {}),
        ...(c.otherDraftsPublished !== undefined
          ? { otherDraftsPublished: c.otherDraftsPublished }
          : {}),
        ...(c.positionFallbacks !== undefined ? { positionFallbacks: c.positionFallbacks } : {}),
        ...(patch.diffHeadSha !== undefined ? { diffHeadSha: patch.diffHeadSha } : {}),
        updatedAt: heartbeat(),
      })
      .where(
        and(
          eq(t.reviewPublications.id, publicationId),
          inArray(t.reviewPublications.status, [...from]),
        ),
      )
      .returning({ id: t.reviewPublications.id });
    return rows.length === 1;
  };

  markOrphanedUnconfirmed = async (): Promise<number> => {
    const rows = await this.db
      .update(t.reviewPublications)
      .set({
        status: 'unconfirmed',
        code: 'gitlab_publish_unconfirmed',
        message: PUBLISH_UNCONFIRMED_MESSAGE,
        updatedAt: heartbeat(),
      })
      .where(eq(t.reviewPublications.status, 'in_progress'))
      .returning({ id: t.reviewPublications.id });
    return rows.length;
  };

  // ---------------------------------------------------------------- internals

  /**
   * Per-item `anchor_kind` update, scoped by `publication_id` — one statement
   * per distinct kind (at most 4), inside the caller's transaction.
   */
  private async updateItemAnchorKinds(
    tx: PublishTx,
    publicationId: string,
    items: readonly PublicationItemAnchorKind[],
  ): Promise<void> {
    const byKind = new Map<PublicationItemAnchorKind['anchorKind'], string[]>();
    for (const { findingId, anchorKind } of items) {
      if (!isUuid(findingId)) continue;
      const list = byKind.get(anchorKind);
      if (list) list.push(findingId);
      else byKind.set(anchorKind, [findingId]);
    }
    for (const [anchorKind, findingIds] of byKind) {
      await tx
        .update(t.reviewPublicationItems)
        .set({ anchorKind })
        .where(
          and(
            eq(t.reviewPublicationItems.publicationId, publicationId),
            inArray(t.reviewPublicationItems.findingId, findingIds),
          ),
        );
    }
  }

  private itemWhere(publicationId: string, findingId: string) {
    return and(
      eq(t.reviewPublicationItems.publicationId, publicationId),
      eq(t.reviewPublicationItems.findingId, findingId),
    );
  }

  /** Column patch + heartbeat on one publication. */
  private async patchPublication(
    publicationId: string,
    values: Partial<Pick<PublicationRow, 'otherDraftsPublished' | 'bulkPublishSentAt'>>,
  ): Promise<void> {
    if (!isUuid(publicationId)) return;
    await this.db
      .update(t.reviewPublications)
      .set({ ...values, updatedAt: heartbeat() })
      .where(eq(t.reviewPublications.id, publicationId));
  }

  /** Publications matching `where` with creator + items, newest first (or oldest for scans). */
  private async loadPublications(
    where: ReturnType<typeof and>,
    order: 'newest' | 'oldest' = 'newest',
  ): Promise<PublicationRecord[]> {
    const rows = await this.db
      .select({ pub: t.reviewPublications, userId: t.users.id, userName: t.users.name })
      .from(t.reviewPublications)
      .leftJoin(t.users, eq(t.users.id, t.reviewPublications.createdBy))
      .where(where)
      .orderBy(
        order === 'newest'
          ? desc(t.reviewPublications.createdAt)
          : asc(t.reviewPublications.updatedAt),
        order === 'newest' ? desc(t.reviewPublications.id) : asc(t.reviewPublications.id),
      );
    if (rows.length === 0) return [];
    const items = await this.db
      .select()
      .from(t.reviewPublicationItems)
      .where(
        inArray(
          t.reviewPublicationItems.publicationId,
          rows.map((r) => r.pub.id),
        ),
      )
      .orderBy(asc(t.reviewPublicationItems.position));
    const byPub = new Map<string, PublicationItemRow[]>();
    for (const item of items) {
      const list = byPub.get(item.publicationId);
      if (list) list.push(item);
      else byPub.set(item.publicationId, [item]);
    }
    return rows.map(({ pub, userId, userName }) =>
      toPublicationRecord(pub, toActor(userId, userName), byPub.get(pub.id) ?? []),
    );
  }
}
