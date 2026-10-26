/**
 * Publication reconciliation (spec `specs/2026-10-21-gitlab-publish-findings.md`,
 * AC-32 – AC-34, AC-41; plan T8). Application ring: no Container, no Fastify,
 * no Drizzle.
 *
 * Settles a publication whose outcome is unknown (`unconfirmed`, or a stale
 * `in_progress` row whose task is no longer alive) by READING GitLab only:
 * marked published notes → `published`; this publication's remaining marked
 * drafts → deleted (idempotent) and their findings rolled back. It NEVER
 * creates a draft and NEVER calls `bulk_publish` (AC-34).
 *
 * The settle helpers below are shared with the executor's AC-32 path.
 */
import type {
  DeprecationReason,
  GitLabDraftNotesHost,
  GitLabMrNote,
  HostRepoRef,
  PublicationStatus,
  PublishAnchorKindAll,
  PublishErrorCode,
} from '@devdigest/shared';
import { ReviewPublishAuditMetadataWithDeprecation } from '@devdigest/shared';
import { AppError } from '../../platform/errors.js';
import { parseMarker } from '../_shared/publish-marker.js';
import { PUBLISH_MESSAGES, PUBLISH_UNCONFIRMED_MESSAGE } from './codes.js';
import type {
  FinishPublicationPatch,
  PublicationRecord,
  PublishAudit,
  PublishClock,
  PublishGitLabAccess,
  PublishLogger,
  PublishStore,
  PublishedItemLink,
} from './ports.js';

/** AC-34: an `in_progress` row older than this (by `updated_at`) is orphaned. */
export const PUBLISH_STALE_AFTER_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shared helpers (executor + reconciler)
// ---------------------------------------------------------------------------

/** A short, body-free error code for logs (never a message: it may echo upstream text). */
export function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  if (err instanceof Error) return err.name;
  return 'unknown';
}

/** `<project web_url>/-/merge_requests/<iid>#note_<id>` (AC-26); https only, else null. */
export function noteUrl(webUrl: string, iid: number, noteId: number): string | null {
  const base = webUrl.replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/i.test(base)) return null;
  return `${base}/-/merge_requests/${iid}#note_${noteId}`;
}

export interface PublishScope {
  workspaceId: string;
  publicationId: string;
}

/** Finding id → this publication's published note, service-account-authored only (AC-24, AC-26). */
export function matchPublishedNotes(
  notes: readonly GitLabMrNote[],
  scope: PublishScope,
  serviceAccount: string,
): Map<string, GitLabMrNote> {
  const found = new Map<string, GitLabMrNote>();
  for (const note of notes) {
    if (note.system || note.author !== serviceAccount) continue;
    const marker = parseMarker(note.body);
    if (!marker) continue;
    if (marker.workspaceId !== scope.workspaceId || marker.publicationId !== scope.publicationId) continue;
    if (!found.has(marker.findingId)) found.set(marker.findingId, note);
  }
  return found;
}

/** An item whose fate is still open (not `failed` / `published` / `rolled_back`). */
export interface SettleItem {
  findingId: string;
  state: 'pending' | 'drafted';
  /** `deferred` only when the run stopped before its background anchor resolution (Q7). */
  anchorKind: PublishAnchorKindAll;
}

export interface SettleTarget extends PublishScope {
  host: Pick<GitLabDraftNotesHost, 'listMrNotes' | 'listOwnDraftNotes' | 'deleteDraftNote'>;
  ref: HostRepoRef;
  iid: number;
  webUrl: string;
  serviceAccount: string;
}

export type SettleResult =
  | { kind: 'unreadable' }
  | {
      kind: 'settled';
      links: PublishedItemLink[];
      /** anchor kinds of the published findings (for `general_notes`). */
      publishedKinds: PublishAnchorKindAll[];
      rolledBack: string[];
      deletedAny: boolean;
      deleteFailed: boolean;
    };

/**
 * AC-32 by reading: published marked notes → links; this publication's
 * remaining marked drafts → deleted; everything else → rolled back. A drafted
 * finding with neither a note nor a draft counts as published (link null,
 * AC-27) only when the publish demonstrably landed (≥ 1 marked note found).
 * Any READ failing → `unreadable` (AC-33). Never creates or publishes.
 */
export async function settleFromHost(
  target: SettleTarget,
  items: readonly SettleItem[],
  now: Date,
): Promise<SettleResult> {
  let notes: GitLabMrNote[];
  let drafts: { id: number; note: string }[];
  try {
    notes = await target.host.listMrNotes(target.ref, target.iid);
    drafts = await target.host.listOwnDraftNotes(target.ref, target.iid);
  } catch {
    return { kind: 'unreadable' };
  }

  const found = matchPublishedNotes(notes, target, target.serviceAccount);
  const remaining = new Set<string>();
  let deletedAny = false;
  let deleteFailed = false;
  for (const draft of drafts) {
    const marker = parseMarker(draft.note);
    if (!marker || marker.workspaceId !== target.workspaceId || marker.publicationId !== target.publicationId) {
      continue; // other drafts: never touched (AC-23, AC-30)
    }
    remaining.add(marker.findingId);
    try {
      await target.host.deleteDraftNote(target.ref, target.iid, draft.id);
      deletedAny = true;
    } catch {
      deleteFailed = true;
    }
  }

  const landed = found.size > 0;
  const links: PublishedItemLink[] = [];
  const publishedKinds: PublishAnchorKindAll[] = [];
  const rolledBack: string[] = [];
  for (const item of items) {
    const note = found.get(item.findingId);
    if (note) {
      links.push({
        findingId: item.findingId,
        discussionId: note.discussionId,
        noteId: note.id,
        url: noteUrl(target.webUrl, target.iid, note.id),
        publishedAt: now,
      });
      publishedKinds.push(item.anchorKind);
    } else if (!remaining.has(item.findingId) && landed && item.state === 'drafted') {
      links.push({ findingId: item.findingId, discussionId: null, noteId: null, url: null, publishedAt: now });
      publishedKinds.push(item.anchorKind);
    } else {
      rolledBack.push(item.findingId);
    }
  }
  return { kind: 'settled', links, publishedKinds, rolledBack, deletedAny, deleteFailed };
}

/** Terminal status + code of a settled publication. */
export function settledOutcome(args: {
  requested: number;
  published: number;
  deleteFailed: boolean;
  /** Code when nothing was published and every marked draft is gone. */
  nothingCode: PublishErrorCode;
}): { status: Exclude<PublicationStatus, 'in_progress' | 'unconfirmed'>; code: PublishErrorCode | null; message: string | null } {
  if (args.published === 0) {
    const code = args.deleteFailed ? 'gitlab_drafts_left_behind' : args.nothingCode;
    return { status: 'failed', code, message: PUBLISH_MESSAGES[code] };
  }
  if (args.deleteFailed) {
    return {
      status: 'partially_published',
      code: 'gitlab_drafts_left_behind',
      message: PUBLISH_MESSAGES.gitlab_drafts_left_behind,
    };
  }
  if (args.published === args.requested) return { status: 'published', code: null, message: null };
  return { status: 'partially_published', code: null, message: null };
}

export interface PublishAuditFacts {
  workspaceId: string;
  actorUserId: string | null;
  reviewId: string;
  prId: string;
  publicationId: string;
  outcome: Exclude<PublicationStatus, 'in_progress' | 'unconfirmed'>;
  requested: number;
  published: number;
  failed: number;
  generalNotes: number;
  otherDraftsPublished: number;
  applicableSuggestions: number;
  hasSummary: boolean;
  /** Outdated-findings AC-26: the run was published as deprecated. */
  deprecated: boolean;
  deprecationReason: DeprecationReason | null;
  /** null when no version lookup happened. */
  reviewedVersionFound: boolean | null;
  positionFallbacks: number;
}

/**
 * Exactly one `review.publish` event (AC-41) — the caller guarantees it won the
 * terminal CAS and that ≥ 1 GitLab write happened. Counts and ids only; `null`
 * audit (local mode, AC-42) records nothing. Never throws.
 */
export async function recordPublishAudit(
  audit: PublishAudit,
  log: PublishLogger,
  facts: PublishAuditFacts,
): Promise<void> {
  if (!audit) return;
  try {
    // Strict: counts, ids and the 4 deprecation facts only — no SHA, body or note id (AC-26).
    const metadata = ReviewPublishAuditMetadataWithDeprecation.parse({
      provider: 'gitlab',
      publication_id: facts.publicationId,
      pr_id: facts.prId,
      outcome: facts.outcome,
      requested: facts.requested,
      published: facts.published,
      failed: facts.failed,
      general_notes: facts.generalNotes,
      other_drafts_published: facts.otherDraftsPublished,
      applicable_suggestions: facts.applicableSuggestions,
      has_summary: facts.hasSummary,
      deprecated: facts.deprecated,
      deprecation_reason: facts.deprecationReason,
      reviewed_version_found: facts.reviewedVersionFound,
      position_fallbacks: facts.positionFallbacks,
    });
    await audit.record({
      workspaceId: facts.workspaceId,
      actorUserId: facts.actorUserId,
      action: 'review.publish',
      targetType: 'review',
      targetId: facts.reviewId,
      metadata,
    });
  } catch (err) {
    log.error({ publicationId: facts.publicationId, code: errorCode(err) }, 'publish audit failed');
  }
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export interface PublishReconcilerDeps {
  store: PublishStore;
  /** The gated GitLab access of one workspace (each workspace has its own token). */
  accessFor: (workspaceId: string) => PublishGitLabAccess;
  /** Live tasks of this process are never reconciled. */
  runner: { isActive: (publicationId: string) => boolean };
  audit: PublishAudit;
  clock: PublishClock;
  log: PublishLogger;
  /** Default `PUBLISH_STALE_AFTER_MS`. */
  staleAfterMs?: number;
}

export class PublishReconciler {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: PublishReconcilerDeps) {}

  /**
   * Fire-and-forget for the preview / list reads (plan Q3): reconciles this
   * PR's `unconfirmed` and stale `in_progress` publications, single-flight per
   * publication. The returned promise never rejects.
   */
  trigger(prId: string): Promise<void> {
    return this.run({ prId }).catch((err) => {
      this.deps.log.warn({ prId, code: errorCode(err) }, 'publish reconcile trigger failed');
    });
  }

  /** Boot pass (plan Q2): every candidate, sequentially; non-fatal. */
  async reconcileAll(): Promise<void> {
    try {
      await this.run({});
    } catch (err) {
      this.deps.log.warn({ code: errorCode(err) }, 'publish boot reconcile failed');
    }
  }

  /** Resolves once every in-flight reconcile has settled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  /** Single-flight reconcile of one publication. Never rejects. */
  reconcile(record: PublicationRecord): Promise<void> {
    const existing = this.inFlight.get(record.id);
    if (existing) return existing;
    const task = this.reconcileOnce(record)
      .catch((err) => {
        this.deps.log.warn({ publicationId: record.id, code: errorCode(err) }, 'publish reconcile failed');
      })
      .finally(() => {
        this.inFlight.delete(record.id);
      });
    this.inFlight.set(record.id, task);
    return task;
  }

  private async run(filter: { prId?: string }): Promise<void> {
    const staleBefore = new Date(this.deps.clock.now().getTime() - (this.deps.staleAfterMs ?? PUBLISH_STALE_AFTER_MS));
    const candidates = await this.deps.store.reconcileCandidates({ ...filter, staleBefore });
    for (const record of candidates) {
      if (this.deps.runner.isActive(record.id)) continue;
      if (record.status !== 'unconfirmed' && record.status !== 'in_progress') continue;
      await this.reconcile(record);
    }
  }

  private async reconcileOnce(record: PublicationRecord): Promise<void> {
    const { store, log, clock } = this.deps;
    if (this.deps.runner.isActive(record.id)) return;
    const from: PublicationStatus[] = [record.status];

    let resolved: Awaited<ReturnType<PublishGitLabAccess['resolve']>>;
    try {
      resolved = await this.deps.accessFor(record.workspaceId).resolve();
    } catch (err) {
      // ConfigError (hosts offline) / gate errors → leave the row as is.
      log.warn({ publicationId: record.id, code: errorCode(err) }, 'publish reconcile: GitLab unavailable');
      return;
    }
    if (!resolved) return;

    const ctx = await store.loadReviewContext(record.workspaceId, record.reviewId);
    if (!ctx || ctx.repo.provider !== 'gitlab') return;

    const open: SettleItem[] = [];
    let failed = 0;
    for (const item of record.items) {
      if (item.state === 'failed') failed += 1;
      if (item.state === 'pending' || item.state === 'drafted') {
        open.push({ findingId: item.findingId, state: item.state, anchorKind: item.anchorKind });
      }
    }
    const alreadyPublished = record.items.filter((i) => i.state === 'published');

    const result = await settleFromHost(
      {
        host: resolved.host,
        ref: ctx.repo.ref,
        iid: ctx.pr.number,
        webUrl: ctx.repo.webUrl,
        serviceAccount: resolved.serviceAccount,
        workspaceId: record.workspaceId,
        publicationId: record.id,
      },
      open,
      clock.now(),
    );

    if (result.kind === 'unreadable') {
      // AC-33: not terminal, no audit. An `unconfirmed` row just stays as is.
      if (record.status === 'in_progress') {
        await store.finish(record.id, from, {
          status: 'unconfirmed',
          code: 'gitlab_publish_unconfirmed',
          message: PUBLISH_UNCONFIRMED_MESSAGE,
          finishedAt: null,
        });
      }
      log.warn({ publicationId: record.id, code: 'gitlab_publish_unconfirmed' }, 'publish reconcile: reads failed');
      return;
    }

    if (result.links.length > 0) await store.markItemsPublished(record.id, result.links);
    if (result.rolledBack.length > 0) await store.markItemsRolledBack(record.id, result.rolledBack);

    const published = alreadyPublished.length + result.links.length;
    const outcome = settledOutcome({
      requested: record.requested,
      published,
      deleteFailed: result.deleteFailed,
      nothingCode: record.bulkPublishSentAt ? 'gitlab_publish_unconfirmed' : 'gitlab_publish_failed',
    });
    const generalNotes =
      alreadyPublished.filter((i) => i.anchorKind === 'general').length +
      result.publishedKinds.filter((k) => k === 'general').length;
    const counters: NonNullable<FinishPublicationPatch['counters']> = {
      published,
      failed,
      generalNotes,
      applicableSuggestions: published > 0 ? Math.min(record.applicableSuggestions, published) : 0,
      otherDraftsPublished: published > 0 ? record.otherDraftsPublished : 0,
      positionFallbacks: published > 0 ? Math.min(record.positionFallbacks, published) : 0,
    };
    const won = await store.finish(record.id, from, {
      status: outcome.status,
      code: outcome.code,
      message: outcome.message,
      finishedAt: clock.now(),
      counters,
    });
    if (!won) return;
    log.warn({ publicationId: record.id, status: outcome.status, code: outcome.code }, 'publish reconciled');

    const wrote =
      record.drafted > 0 ||
      record.bulkPublishSentAt != null ||
      record.items.some((i) => i.draftId != null) ||
      result.deletedAny;
    if (!wrote) return;
    await recordPublishAudit(this.deps.audit, log, {
      workspaceId: record.workspaceId,
      actorUserId: record.createdBy?.id ?? null,
      reviewId: record.reviewId,
      prId: record.prId,
      publicationId: record.id,
      outcome: outcome.status,
      requested: record.requested,
      published,
      failed,
      generalNotes,
      otherDraftsPublished: counters.otherDraftsPublished ?? 0,
      applicableSuggestions: counters.applicableSuggestions ?? 0,
      hasSummary: record.hasSummary,
      deprecated: record.deprecated,
      deprecationReason: record.deprecationReason,
      reviewedVersionFound: record.reviewedVersionFound,
      positionFallbacks: counters.positionFallbacks ?? 0,
    });
  }
}
