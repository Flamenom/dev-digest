/**
 * `PublishService` — the synchronous half of "publish findings to GitLab"
 * (spec `specs/2026-10-21-gitlab-publish-findings.md`, AC-2 – AC-8, AC-12,
 * AC-20 – AC-22, AC-38; plan T9, Q1, Q3). Application ring: explicit deps
 * object, no Container, no Fastify, no Drizzle.
 *
 * `create` follows AC-20's order strictly: steps 1–5 (review, body, blockers,
 * per-finding checks, the per-PR lock) make 0 GitLab requests. Only then is the
 * token gate resolved and the MR's diff refs read (Q1); any failure from there
 * on deletes the just-inserted publication. The background work is handed to
 * the runner and never awaited (AC-21).
 *
 * Never logs the summary, a note body or a token — codes and ids only.
 */
import { PublishRequest } from '@devdigest/shared';
import type {
  GitLabTokenHealth,
  OtherDraftsCount,
  Publication,
  PublicationItem,
  PublishPreview,
} from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { sanitiseFooterName } from '../_shared/gitlab-note-text.js';
import { parseMarker } from '../_shared/publish-marker.js';
import { compareForSend, resolveAnchor } from './anchor.js';
import { publishError } from './codes.js';
import type { PublishRunInput, PublishRunItem } from './executor.js';
import {
  FindingAlreadyPublishedError,
  PublishInProgressError,
  type PublicationRecord,
  type PublishClock,
  type PublishFindingRow,
  type PublishGitLabAccess,
  type PublishLogger,
  type PublishReviewContext,
  type PublishStore,
} from './ports.js';
import { buildPreview, findingReason, reviewBlockers, safeHttpsUrl } from './preview.js';

/** AC-28: total 429 waiting allowed per publication. */
export const PUBLISH_WAIT_BUDGET_MS = 60_000;

export interface PublishServiceDeps {
  store: PublishStore;
  gitlab: PublishGitLabAccess;
  /** `GitLabTokenHealthService.current()` — makes no GitLab call. null ⇒ no token. */
  tokenHealth: () => Promise<GitLabTokenHealth | null>;
  /** The acting user's display name + email (footer), or null. */
  actorName: (userId: string) => Promise<{ name: string | null; email: string | null } | null>;
  /** true ⇒ google mode: notes and summary carry the attribution footer. */
  footerEnabled: boolean;
  /** Starts the detached background task; must not throw and is never awaited. */
  runner: { start: (input: PublishRunInput) => void };
  /** Fire-and-forget, single-flight reconciliation of stale publications (AC-34, Q3). */
  reconciler: { trigger: (prId: string) => void | Promise<void> };
  clock: PublishClock;
  log?: PublishLogger;
}

/** A Zod issue, matched by shape (vendored duplicate zod instances). */
interface IssueLike {
  path: readonly (string | number)[];
}

function hasIssues(err: unknown): err is { issues: IssueLike[] } {
  return (
    typeof err === 'object' &&
    err !== null &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

function isInProgressError(err: unknown): err is PublishInProgressError {
  return (
    err instanceof PublishInProgressError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'PublishInProgressError' &&
      typeof (err as { runningPublicationId?: unknown }).runningPublicationId === 'string')
  );
}

function isAlreadyPublishedError(err: unknown): err is FindingAlreadyPublishedError {
  return (
    err instanceof FindingAlreadyPublishedError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'FindingAlreadyPublishedError' &&
      Array.isArray((err as { findingIds?: unknown }).findingIds))
  );
}

/** `{ code }` of an error by shape — never its message (may echo upstream text). */
function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** Repository domain record → the `Publication` contract (AC-21, AC-39). */
export function toPublicationDto(record: PublicationRecord): Publication {
  const items: PublicationItem[] = record.items.map((item) => ({
    finding_id: item.findingId,
    state: item.state,
    code: item.code,
    link:
      item.state === 'published'
        ? {
            discussion_id: item.discussionId,
            note_id: item.noteId,
            url: safeHttpsUrl(item.url),
            published_at: (item.publishedAt ?? record.finishedAt ?? record.updatedAt).toISOString(),
            published_by: record.createdBy,
            publication_id: record.id,
          }
        : null,
  }));
  return {
    id: record.id,
    review_id: record.reviewId,
    pr_id: record.prId,
    status: record.status,
    code: record.code,
    message: record.message,
    requested: record.requested,
    drafted: record.drafted,
    published: record.published,
    failed: record.failed,
    general_notes: record.generalNotes,
    other_drafts_published: record.otherDraftsPublished,
    has_summary: record.hasSummary,
    apply_suggestions: record.applySuggestions,
    created_by: record.createdBy,
    created_at: record.createdAt.toISOString(),
    finished_at: record.finishedAt ? record.finishedAt.toISOString() : null,
    items,
  };
}

export class PublishService {
  constructor(private readonly deps: PublishServiceDeps) {}

  /** `GET /reviews/:id/publish-preview` — 0 GitLab requests (AC-2). */
  async preview(
    workspaceId: string,
    reviewId: string,
    viewerCanPublish: boolean,
  ): Promise<PublishPreview> {
    const ctx = await this.loadContext(workspaceId, reviewId);
    this.triggerReconcile(ctx.pr.id);
    const [states, inProgress, tokenHealth] = await Promise.all([
      this.deps.store.findingStates(ctx.findings.map((f) => f.id)),
      this.deps.store.inProgressForPr(ctx.pr.id),
      this.healthFor(ctx),
    ]);
    return buildPreview({ ctx, states, inProgress, tokenHealth, viewerCanPublish });
  }

  /**
   * `GET /reviews/:id/publish-other-drafts` (AC-38): one list request, no
   * writes. Counts the service account's drafts NOT carrying this workspace's
   * marker. Any failure (gate included) → `null` (fallback warning).
   */
  async otherDraftsCount(workspaceId: string, reviewId: string): Promise<OtherDraftsCount> {
    const ctx = await this.loadContext(workspaceId, reviewId);
    if (ctx.repo.provider !== 'gitlab') throw publishError('provider_not_supported');
    try {
      const access = await this.deps.gitlab.resolve();
      if (!access) return { other_drafts: null };
      const drafts = await access.host.listOwnDraftNotes(ctx.repo.ref, ctx.pr.number);
      const other = drafts.filter((d) => parseMarker(d.note)?.workspaceId !== workspaceId).length;
      return { other_drafts: other };
    } catch (err) {
      this.deps.log?.warn({ code: errorCode(err), reviewId }, 'publish: other-drafts count failed');
      return { other_drafts: null };
    }
  }

  /** `POST /reviews/:id/publications` — strictly in AC-20 order; 202 set by the route. */
  async create(
    workspaceId: string,
    reviewId: string,
    rawBody: unknown,
    actorUserId: string | null,
  ): Promise<Publication> {
    const { store } = this.deps;

    // 1. The review exists in this workspace.
    const ctx = await this.loadContext(workspaceId, reviewId);

    // 2. Body: selection first (AC-20 step 3), then summary / toggle (step 4).
    const parsed = PublishRequest.safeParse(rawBody);
    if (!parsed.success) {
      const issues: IssueLike[] = hasIssues(parsed.error) ? parsed.error.issues : [];
      const selection = issues.length === 0 || issues.some((i) => i.path.length === 0 || i.path[0] === 'finding_ids');
      throw publishError(selection ? 'publish_selection_invalid' : 'publish_summary_invalid');
    }
    const body = parsed.data;
    const byId = new Map(ctx.findings.map((f) => [f.id, f]));
    const selected: PublishFindingRow[] = [];
    for (const id of body.finding_ids) {
      // Finding ids are stored lowercase; a case variant of the same id is a duplicate.
      const finding = byId.get(id.toLowerCase()) ?? byId.get(id);
      if (!finding || selected.includes(finding)) throw publishError('publish_selection_invalid');
      selected.push(finding);
    }

    // 3. Review-level blockers (AC-3 – AC-8), first one wins.
    const [inProgress, tokenHealth] = await Promise.all([
      store.inProgressForPr(ctx.pr.id),
      this.healthFor(ctx),
    ]);
    const blockers = reviewBlockers({ ctx, inProgress, tokenHealth });
    const first = blockers[0];
    if (first) {
      throw publishError(
        first.code,
        first.publication_id ? { publication_id: first.publication_id } : undefined,
      );
    }

    // 4. Per finding (AC-9 off-diff is accepted; AC-18; AC-35).
    const states = await store.findingStates(selected.map((f) => f.id));
    // AC-22 race: a concurrent publication on this PR may have been created
    // between the blocker read above and this read. Its `pending` items would
    // otherwise surface as `publish_unconfirmed` (400); the PR is locked, so
    // answer what the lock means. A finding's publication is always on this
    // review's PR, so `in_progress` here IS the per-PR lock holder.
    const running = states.find((s) => s.publicationStatus === 'in_progress');
    if (running) throw publishError('publish_in_progress', { publication_id: running.publicationId });
    const liveByFinding = new Map(states.map((s) => [s.findingId, s]));
    const notPublishable: string[] = [];
    const alreadyPublished: string[] = [];
    const planned: PublishRunItem[] = [];
    for (const finding of selected) {
      const anchor = resolveAnchor(finding, ctx.files);
      const reason = findingReason(finding, anchor, liveByFinding.get(finding.id));
      if (reason === 'already_published') alreadyPublished.push(finding.id);
      else if (reason != null) notPublishable.push(finding.id);
      planned.push({ finding, anchor });
    }
    if (notPublishable.length > 0) {
      throw publishError('finding_not_publishable', { finding_ids: notPublishable });
    }
    if (alreadyPublished.length > 0) {
      throw publishError('finding_already_published', { finding_ids: alreadyPublished });
    }
    planned.sort((a, b) => compareForSend(a.finding, b.finding));

    // 5. The per-PR lock + per-finding live guard (AC-22, AC-35).
    let record: PublicationRecord;
    try {
      record = await store.createPublication({
        workspaceId,
        reviewId,
        prId: ctx.pr.id,
        createdBy: actorUserId,
        hasSummary: body.summary !== undefined,
        applySuggestions: body.apply_suggestions,
        items: planned.map((p, position) => ({
          findingId: p.finding.id,
          position,
          anchorKind: p.anchor.kind,
        })),
      });
    } catch (err) {
      if (isInProgressError(err)) {
        throw publishError('publish_in_progress', { publication_id: err.runningPublicationId });
      }
      if (isAlreadyPublishedError(err)) {
        throw publishError('finding_already_published', { finding_ids: [...err.findingIds] });
      }
      throw err;
    }

    // 6 – 9. From here on, any failure removes the publication (Q1).
    try {
      // 6. Token gate (no token → missing; gate errors propagate mapped).
      const access = await this.deps.gitlab.resolve();
      if (!access) throw publishError('gitlab_token_missing');

      // 7. The MR's current diff must be the reviewed one (AC-12) — 1 read, 0 writes.
      const refs = await access.host.getDiffRefs(ctx.repo.ref, ctx.pr.number);
      if (refs.headSha !== ctx.review.headSha) throw publishError('review_diff_outdated');

      // 8. Footer name (google mode only, AC-42).
      let footerName: string | null = null;
      if (this.deps.footerEnabled) {
        const who = actorUserId ? await this.deps.actorName(actorUserId) : null;
        footerName = sanitiseFooterName(who?.name ?? null, who?.email ?? null);
      }

      // 9. Background — never awaited (AC-21).
      this.deps.runner.start({
        publicationId: record.id,
        workspaceId,
        reviewId,
        prId: ctx.pr.id,
        actorUserId,
        repoRef: ctx.repo.ref,
        iid: ctx.pr.number,
        webUrl: ctx.repo.webUrl,
        refs,
        host: access.host,
        serviceAccount: access.serviceAccount,
        items: planned,
        summary: body.summary ?? null,
        applySuggestions: body.apply_suggestions,
        footerName,
        budget: { remainingMs: PUBLISH_WAIT_BUDGET_MS },
      });
    } catch (err) {
      await this.discard(record.id, err);
      throw err;
    }

    // 10. The in-progress publication (202).
    return toPublicationDto(record);
  }

  /** `GET /publications/:id`. */
  async get(workspaceId: string, publicationId: string): Promise<Publication> {
    const record = await this.deps.store.getPublication(workspaceId, publicationId);
    if (!record) throw new NotFoundError('Publication not found');
    this.triggerReconcile(record.prId);
    return toPublicationDto(record);
  }

  /** `GET /reviews/:id/publications` — newest first. */
  async listForReview(workspaceId: string, reviewId: string): Promise<Publication[]> {
    const ctx = await this.loadContext(workspaceId, reviewId);
    this.triggerReconcile(ctx.pr.id);
    const records = await this.deps.store.listForReview(workspaceId, reviewId);
    return records.map(toPublicationDto);
  }

  // ---------- internals ----------

  private async loadContext(workspaceId: string, reviewId: string): Promise<PublishReviewContext> {
    const ctx = await this.deps.store.loadReviewContext(workspaceId, reviewId);
    if (!ctx) throw new NotFoundError('Review not found');
    return ctx;
  }

  /** Token health is only meaningful (and only read) for GitLab reviews. */
  private async healthFor(ctx: PublishReviewContext): Promise<GitLabTokenHealth | null> {
    return ctx.repo.provider === 'gitlab' ? this.deps.tokenHealth() : null;
  }

  /** Fire-and-forget (Q3): never awaited, never fails the read. */
  private triggerReconcile(prId: string): void {
    try {
      const pending = this.deps.reconciler.trigger(prId);
      if (pending && typeof (pending as Promise<void>).catch === 'function') {
        (pending as Promise<void>).catch((err: unknown) => {
          this.deps.log?.warn({ code: errorCode(err), prId }, 'publish: reconcile trigger failed');
        });
      }
    } catch (err) {
      this.deps.log?.warn({ code: errorCode(err), prId }, 'publish: reconcile trigger failed');
    }
  }

  /** Removes a publication whose synchronous pre-checks failed; the original error wins. */
  private async discard(publicationId: string, cause: unknown): Promise<void> {
    try {
      await this.deps.store.deletePublication(publicationId);
    } catch (err) {
      this.deps.log?.error(
        { publicationId, code: errorCode(err), causeCode: errorCode(cause) },
        'publish: could not delete the rejected publication',
      );
    }
  }
}
