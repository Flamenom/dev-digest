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
import { PublishAcknowledgement, PublishPlanQuery, PublishRequest } from '@devdigest/shared';
import type {
  GitLabTokenHealth,
  OtherDraftsCount,
  PublicationItemWithDeprecation,
  PublicationWithDeprecation,
  PublishLiveDeprecation,
  PublishPlan,
  PublishPreviewWithDeprecation,
} from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { sanitiseFooterName } from '../_shared/gitlab-note-text.js';
import { parseMarker } from '../_shared/publish-marker.js';
import { compareForSend, generalAnchor, resolveAnchor, type PlannedAnchor } from './anchor.js';
import {
  countPlacement,
  planAnchors,
  resolveReviewedVersion,
  type PlanAnchorSource,
} from './anchor-source.js';
import { publishError } from './codes.js';
import type { PublishRunInput, PublishRunItem } from './executor.js';
import {
  FindingAlreadyPublishedError,
  PublishInProgressError,
  type AnchorSource,
  type PublicationItemAnchorKind,
  type PublicationRecord,
  type PublishClock,
  type PublishDeprecationState,
  type PublishFindingRow,
  type PublishGitLabAccess,
  type PublishLogger,
  type PublishReviewContext,
  type PublishStore,
} from './ports.js';
import { boundAnchorFor, buildPreview, findingReason, reviewBlockers, safeHttpsUrl } from './preview.js';

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

/**
 * Where a run's anchors come from (plan "Anchor-source decision", AC-6):
 * head unknown → `none`; the live head moved, or the persisted files are not
 * the reviewed head's → `reviewed_version`; else `persisted` (base behaviour).
 */
export function decideAnchorSource(
  reviewHeadSha: string | null,
  liveHeadSha: string,
  detailHeadSha: string | null,
): AnchorSource {
  if (reviewHeadSha == null) return 'none';
  if (reviewHeadSha !== liveHeadSha || detailHeadSha !== reviewHeadSha) return 'reviewed_version';
  return 'persisted';
}

/** AC-3: decided once against the live head; null = not deprecated. */
export function decideDeprecation(
  reviewHeadSha: string | null,
  liveHeadSha: string,
): PublishDeprecationState | null {
  if (reviewHeadSha == null) return { reason: 'head_unknown', reviewedHeadSha: null };
  if (reviewHeadSha !== liveHeadSha) return { reason: 'head_moved', reviewedHeadSha: reviewHeadSha };
  return null;
}

/**
 * The anchor a finding is planned with before the live refs read: general
 * `review_head_unknown` for a legacy review; null (deferred) when the
 * persisted files are not the reviewed head's; else the persisted resolution.
 */
function plannedAnchorAtCreate(ctx: PublishReviewContext, finding: PublishFindingRow): PlannedAnchor | null {
  if (ctx.review.headSha == null) return generalAnchor(finding, 'review_head_unknown');
  if (ctx.review.headSha !== ctx.pr.detailHeadSha) return null;
  return resolveAnchor(finding, ctx.files);
}

/** Repository domain record → the `Publication` contract (AC-21, AC-39; outdated-findings AC-25). */
export function toPublicationDto(record: PublicationRecord): PublicationWithDeprecation {
  const items: PublicationItemWithDeprecation[] = record.items.map((item) => ({
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
            deprecated: record.deprecated,
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
    deprecated: record.deprecated,
    deprecation_reason: record.deprecationReason,
    reviewed_version_found: record.reviewedVersionFound,
    position_fallbacks: record.positionFallbacks,
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
  ): Promise<PublishPreviewWithDeprecation> {
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
    return this.countOtherDrafts(workspaceId, ctx);
  }

  /**
   * `GET /reviews/:id/publish-plan?finding_ids=…` (outdated-findings AC-21):
   * the other-drafts count plus the live deprecation and the placement counts
   * of the selected findings, from live reads (refs, versions, one version
   * diff). Only GETs — never a write. Any failure of the placement half
   * (gate, refs, a fatal version read) → `plan_available: false`.
   */
  async publishPlan(workspaceId: string, reviewId: string, rawQuery: unknown): Promise<PublishPlan> {
    const ctx = await this.loadContext(workspaceId, reviewId);
    if (ctx.repo.provider !== 'gitlab') throw publishError('provider_not_supported');
    const parsed = PublishPlanQuery.safeParse(rawQuery);
    if (!parsed.success) throw publishError('publish_selection_invalid');
    const selected = this.selectFindings(ctx, parsed.data.finding_ids);

    const [drafts, placement] = await Promise.all([
      this.countOtherDrafts(workspaceId, ctx),
      this.planPlacement(ctx, selected),
    ]);
    if (placement == null) return { ...drafts, plan_available: false, placement: null };
    return { ...drafts, plan_available: true, deprecation: placement.deprecation, placement: placement.counts };
  }

  /** `POST /reviews/:id/publications` — strictly in AC-20 order; 202 set by the route. */
  async create(
    workspaceId: string,
    reviewId: string,
    rawBody: unknown,
    actorUserId: string | null,
  ): Promise<PublicationWithDeprecation> {
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
    const selected = this.selectFindings(ctx, body.finding_ids);
    // Outdated-findings AC-4 / Q4: parsed from the same raw body; a non-boolean
    // flag is a body error like a non-boolean `apply_suggestions`. It can only
    // permit a deprecated publish — it never decides deprecation.
    const ack = PublishAcknowledgement.safeParse(rawBody);
    if (!ack.success) throw publishError('publish_summary_invalid');
    const acknowledged = ack.data.acknowledge_deprecated;

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
      const anchor = plannedAnchorAtCreate(ctx, finding);
      const reason = findingReason(finding, boundAnchorFor(finding, anchor), liveByFinding.get(finding.id));
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
          anchorKind: p.anchor?.kind ?? 'deferred',
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

      // 7. The live diff refs — 1 read, 0 writes. Deprecation and the anchor
      // source are decided here, once, and never re-read (outdated-findings
      // AC-3, AC-28). A deprecated run needs the client's acknowledgement (AC-4).
      const refs = await access.host.getDiffRefs(ctx.repo.ref, ctx.pr.number);
      const deprecation = decideDeprecation(ctx.review.headSha, refs.headSha);
      if (deprecation && !acknowledged) {
        throw publishError(deprecation.reason === 'head_moved' ? 'review_diff_outdated' : 'review_head_unknown');
      }
      const anchorSource = decideAnchorSource(ctx.review.headSha, refs.headSha, ctx.pr.detailHeadSha);
      if (anchorSource === 'reviewed_version') {
        // Anchors planned against the persisted diff no longer apply: the
        // background resolution anchors on the reviewed version (AC-6, AC-11).
        for (const p of planned) p.anchor = null;
      }
      const kinds: PublicationItemAnchorKind[] = planned.map((p) => ({
        findingId: p.finding.id,
        anchorKind: p.anchor?.kind ?? 'deferred',
      }));
      await store.setStartDecision(record.id, {
        deprecationReason: deprecation?.reason ?? null,
        items: kinds,
      });
      const kindById = new Map(kinds.map((k) => [k.findingId, k.anchorKind]));
      record = {
        ...record,
        deprecated: deprecation != null,
        deprecationReason: deprecation?.reason ?? null,
        items: record.items.map((i) => ({ ...i, anchorKind: kindById.get(i.findingId) ?? i.anchorKind })),
      };

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
        deprecation,
        anchorSource,
        reviewHeadSha: ctx.review.headSha,
      });
    } catch (err) {
      await this.discard(record.id, err);
      throw err;
    }

    // 10. The in-progress publication (202).
    return toPublicationDto(record);
  }

  /** `GET /publications/:id`. */
  async get(workspaceId: string, publicationId: string): Promise<PublicationWithDeprecation> {
    const record = await this.deps.store.getPublication(workspaceId, publicationId);
    if (!record) throw new NotFoundError('Publication not found');
    this.triggerReconcile(record.prId);
    return toPublicationDto(record);
  }

  /** `GET /reviews/:id/publications` — newest first. */
  async listForReview(workspaceId: string, reviewId: string): Promise<PublicationWithDeprecation[]> {
    const ctx = await this.loadContext(workspaceId, reviewId);
    this.triggerReconcile(ctx.pr.id);
    const records = await this.deps.store.listForReview(workspaceId, reviewId);
    return records.map(toPublicationDto);
  }

  // ---------- internals ----------

  /** Selected ids → this review's findings; a foreign id or a duplicate (case variants included) → 400. */
  private selectFindings(ctx: PublishReviewContext, ids: readonly string[]): PublishFindingRow[] {
    const byId = new Map(ctx.findings.map((f) => [f.id, f]));
    const selected: PublishFindingRow[] = [];
    for (const id of ids) {
      // Finding ids are stored lowercase; a case variant of the same id is a duplicate.
      const finding = byId.get(id.toLowerCase()) ?? byId.get(id);
      if (!finding || selected.includes(finding)) throw publishError('publish_selection_invalid');
      selected.push(finding);
    }
    return selected;
  }

  /** AC-38: one list request, no writes; any failure (gate included) → null. */
  private async countOtherDrafts(workspaceId: string, ctx: PublishReviewContext): Promise<OtherDraftsCount> {
    try {
      const access = await this.deps.gitlab.resolve();
      if (!access) return { other_drafts: null };
      const drafts = await access.host.listOwnDraftNotes(ctx.repo.ref, ctx.pr.number);
      const other = drafts.filter((d) => parseMarker(d.note)?.workspaceId !== workspaceId).length;
      return { other_drafts: other };
    } catch (err) {
      this.deps.log?.warn({ code: errorCode(err), reviewId: ctx.review.id }, 'publish: other-drafts count failed');
      return { other_drafts: null };
    }
  }

  /**
   * The placement half of the publish plan (AC-21): the same decision table
   * and the same `planAnchors` as the publish (Rec3). null = unavailable.
   */
  private async planPlacement(
    ctx: PublishReviewContext,
    selected: readonly PublishFindingRow[],
  ): Promise<{ deprecation: PublishLiveDeprecation | null; counts: { positioned: number; general: number } } | null> {
    try {
      const access = await this.deps.gitlab.resolve();
      if (!access) return null;
      const refs = await access.host.getDiffRefs(ctx.repo.ref, ctx.pr.number);
      const live = decideDeprecation(ctx.review.headSha, refs.headSha);
      const deprecation: PublishLiveDeprecation | null = live
        ? { reason: live.reason, reviewed_head_sha: live.reviewedHeadSha, live_head_sha: refs.headSha }
        : null;

      let source: PlanAnchorSource;
      switch (decideAnchorSource(ctx.review.headSha, refs.headSha, ctx.pr.detailHeadSha)) {
        case 'none':
          source = { kind: 'none' };
          break;
        case 'persisted':
          source = { kind: 'persisted', files: ctx.files };
          break;
        case 'reviewed_version':
          source = await resolveReviewedVersion(
            access.host,
            ctx.repo.ref,
            ctx.pr.number,
            ctx.review.headSha as string,
            this.deps.log,
          );
          break;
      }
      if (source.kind === 'fatal') return null;
      return { deprecation, counts: countPlacement(planAnchors(selected, source)) };
    } catch (err) {
      this.deps.log?.warn({ code: errorCode(err), reviewId: ctx.review.id }, 'publish: plan read failed');
      return null;
    }
  }

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
