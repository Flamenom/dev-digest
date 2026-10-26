/**
 * Pure: the publish preview of one review (spec
 * `specs/2026-10-21-gitlab-publish-findings.md`, AC-2 – AC-8, AC-17, AC-18;
 * plan T9; extended by `specs/2026-10-23-gitlab-publish-outdated-findings.md`
 * AC-1, AC-2, AC-16, AC-18, AC-19). No I/O — the service gathers the inputs from the store and the
 * token-health cache, so the preview makes 0 GitLab requests (AC-2).
 *
 * The blocker list and the per-finding reason are exported separately because
 * `PublishService.create` re-uses them for the AC-20 validation, so preview and
 * publish can never disagree on what is publishable.
 */
import type {
  FindingCategory,
  FindingUnpublishableReason,
  GitLabTokenHealth,
  PublishBlocker,
  PublishBlockerCode,
  PublishDeprecation,
  PublishedLinkWithDeprecation,
  PublishPreviewFindingWithDeprecation,
  PublishPreviewWithDeprecation,
} from '@devdigest/shared';
import {
  deferredPublishAnchor,
  generalAnchor,
  resolveAnchor,
  toPublishAnchor,
  type AnchorableFinding,
  type PlannedAnchor,
} from './anchor.js';
import { blockerMessage } from './codes.js';
import { isBodyTooLong, suggestionEligibility, type NoteFinding } from './note-body.js';
import type { FindingLiveState, PublishFindingRow, PublishReviewContext } from './ports.js';

export interface BuildPreviewInput {
  ctx: PublishReviewContext;
  /** Live items of the review's findings (`store.findingStates`). */
  states: readonly FindingLiveState[];
  /** The PR's in-progress publication, any review / user (AC-6). */
  inProgress: { id: string } | null;
  /**
   * `GitLabTokenHealthService.current()` — no GitLab call. null ⇒ no token
   * stored. Ignored for GitHub.
   */
  tokenHealth: GitLabTokenHealth | null;
  /** Derived from the publish route's policy row by the route (AC-40, Q6). */
  viewerCanPublish: boolean;
}

/** PR states that block a publish (a draft MR is open, AC-8). */
const CLOSED_PR_STATES: ReadonlySet<string> = new Set(['merged', 'closed']);

function blocker(code: PublishBlockerCode, publicationId?: string): PublishBlocker {
  return publicationId === undefined
    ? { code, message: blockerMessage(code) }
    : { code, message: blockerMessage(code), publication_id: publicationId };
}

function tokenBlocker(health: GitLabTokenHealth | null): PublishBlocker | null {
  if (health == null) return blocker('gitlab_token_missing');
  if (health === 'insufficient_scope') return blocker('gitlab_token_insufficient_scope');
  if (health === 'invalid') return blocker('gitlab_token_invalid');
  return null; // ok | unchecked — the gate re-checks at publish time
}

/**
 * Review-level deprecation from persisted state only — 0 I/O (outdated-findings
 * AC-1): `head_sha` null → `head_unknown`; ≠ the PR's persisted head →
 * `head_moved`; else null. The publish re-decides against the live refs (AC-3).
 */
export function previewDeprecation(ctx: PublishReviewContext): PublishDeprecation | null {
  const head = ctx.review.headSha;
  if (head == null) return { reason: 'head_unknown', reviewed_head_sha: null };
  if (head !== ctx.pr.headSha) return { reason: 'head_moved', reviewed_head_sha: head };
  return null;
}

/**
 * The preview placement of one finding (outdated-findings AC-19, plan Q1):
 * - `head_unknown` → general `review_head_unknown`;
 * - `head_moved`, or the persisted files are stale (`headSha ≠ detailHeadSha`)
 *   → `null` = deferred: the publish anchors on the reviewed MR diff version;
 * - else the base resolution against the persisted MR diff.
 */
export function previewPlannedAnchor(
  ctx: PublishReviewContext,
  deprecation: PublishDeprecation | null,
  finding: AnchorableFinding,
): PlannedAnchor | null {
  if (deprecation?.reason === 'head_unknown') return generalAnchor(finding, 'review_head_unknown');
  if (deprecation?.reason === 'head_moved' || ctx.review.headSha !== ctx.pr.detailHeadSha) return null;
  return resolveAnchor(finding, ctx.files);
}

/**
 * The anchor `findingReason` checks `body_too_long` against. A deferred
 * finding (null) is bound by its general anchor — the AC-18 worst-case
 * overhead is charged to every anchor kind, so the bound is the same whatever
 * placement the publish later picks.
 */
export function boundAnchorFor(finding: AnchorableFinding, planned: PlannedAnchor | null): PlannedAnchor {
  return planned ?? generalAnchor(finding, 'not_on_diff_line');
}

/**
 * Review-level blockers in the AC-3 – AC-8 order. A GitHub review reports
 * `provider_not_supported` and nothing else (AC-3). An unknown or moved head
 * is no longer a blocker — it is a deprecation (outdated-findings AC-2).
 */
export function reviewBlockers(input: Omit<BuildPreviewInput, 'states' | 'viewerCanPublish'>): PublishBlocker[] {
  const { ctx, inProgress, tokenHealth } = input;
  if (ctx.repo.provider !== 'gitlab') return [blocker('provider_not_supported')];

  const out: PublishBlocker[] = [];
  if (CLOSED_PR_STATES.has(ctx.pr.status)) out.push(blocker('pr_not_open'));
  if (inProgress) out.push(blocker('publish_in_progress', inProgress.id));
  const token = tokenBlocker(tokenHealth);
  if (token) out.push(token);
  return out;
}

/**
 * The note-composer view of a finding. `category` is persisted as text; the
 * composer only interpolates it, so the narrowing is a type-level formality.
 */
export function toNoteFinding(f: PublishFindingRow): NoteFinding {
  return {
    severity: f.severity,
    category: f.category as FindingCategory,
    title: f.title,
    rationale: f.rationale,
    suggestion: f.suggestion,
    kind: f.kind,
    evidence: f.evidence,
  };
}

/**
 * Why one finding cannot be selected, or null (AC-2, AC-18, AC-20 step 6).
 * Order: dismissed → already published → publish unconfirmed → too long.
 * A live item of an in-progress publication also reads `publish_unconfirmed`
 * (the PR-level `publish_in_progress` blocker covers that case).
 */
export function findingReason(
  finding: PublishFindingRow,
  anchor: PlannedAnchor,
  live: FindingLiveState | undefined,
): FindingUnpublishableReason | null {
  if (finding.dismissed_at != null) return 'dismissed';
  if (live?.state === 'published') return 'already_published';
  if (live) return 'publish_unconfirmed';
  if (isBodyTooLong(toNoteFinding(finding), anchor)) return 'body_too_long';
  return null;
}

/** https only — anything else is dropped to "link unavailable" (AC-36, NFR security). */
export function safeHttpsUrl(url: string | null): string | null {
  return url != null && url.startsWith('https://') ? url : null;
}

function publishedLink(live: FindingLiveState): PublishedLinkWithDeprecation {
  return {
    discussion_id: live.discussionId,
    note_id: live.noteId,
    url: safeHttpsUrl(live.url),
    published_at: live.publishedAt ? live.publishedAt.toISOString() : '',
    published_by: live.publishedBy,
    publication_id: live.publicationId,
    deprecated: live.publicationDeprecated,
  };
}

/** `GET /reviews/:id/publish-preview` (AC-2; outdated-findings AC-1, AC-19). */
export function buildPreview(input: BuildPreviewInput): PublishPreviewWithDeprecation {
  const { ctx, states, viewerCanPublish } = input;
  const liveByFinding = new Map(states.map((s) => [s.findingId, s]));
  const deprecation = previewDeprecation(ctx);

  const findings: PublishPreviewFindingWithDeprecation[] = ctx.findings.map((finding) => {
    const planned = previewPlannedAnchor(ctx, deprecation, finding);
    const bound = boundAnchorFor(finding, planned);
    const live = liveByFinding.get(finding.id);
    const reason = findingReason(finding, bound, live);
    return {
      finding_id: finding.id,
      publishable: reason == null,
      reason,
      anchor: planned == null ? deferredPublishAnchor(finding) : toPublishAnchor(planned),
      // AC-16: never applicable while deprecated; a deferred placement is unknown.
      suggestion_eligible:
        deprecation == null && planned != null && suggestionEligibility(toNoteFinding(finding), planned),
      published: live?.state === 'published' ? publishedLink(live) : null,
    };
  });

  return {
    review_id: ctx.review.id,
    provider: ctx.repo.provider,
    mr_iid: ctx.repo.provider === 'gitlab' ? ctx.pr.number : null,
    viewer_can_publish: viewerCanPublish,
    blockers: reviewBlockers(input),
    deprecation,
    findings,
  };
}
