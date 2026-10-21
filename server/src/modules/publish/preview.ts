/**
 * Pure: the publish preview of one review (spec
 * `specs/2026-10-21-gitlab-publish-findings.md`, AC-2 – AC-8, AC-17, AC-18;
 * plan T9). No I/O — the service gathers the inputs from the store and the
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
  PublishedLink,
  PublishPreview,
  PublishPreviewFinding,
} from '@devdigest/shared';
import { resolveAnchor, toPublishAnchor, type PlannedAnchor } from './anchor.js';
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
 * Review-level blockers in the AC-3 – AC-8 order. A GitHub review reports
 * `provider_not_supported` and nothing else (AC-3).
 */
export function reviewBlockers(input: Omit<BuildPreviewInput, 'states' | 'viewerCanPublish'>): PublishBlocker[] {
  const { ctx, inProgress, tokenHealth } = input;
  if (ctx.repo.provider !== 'gitlab') return [blocker('provider_not_supported')];

  const out: PublishBlocker[] = [];
  const head = ctx.review.headSha;
  if (head == null) {
    out.push(blocker('review_head_unknown'));
  } else if (head !== ctx.pr.headSha || head !== ctx.pr.detailHeadSha) {
    out.push(blocker('review_diff_outdated'));
  }
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

function publishedLink(live: FindingLiveState): PublishedLink {
  return {
    discussion_id: live.discussionId,
    note_id: live.noteId,
    url: safeHttpsUrl(live.url),
    published_at: live.publishedAt ? live.publishedAt.toISOString() : '',
    published_by: live.publishedBy,
    publication_id: live.publicationId,
  };
}

/** `GET /reviews/:id/publish-preview` (AC-2). */
export function buildPreview(input: BuildPreviewInput): PublishPreview {
  const { ctx, states, viewerCanPublish } = input;
  const liveByFinding = new Map(states.map((s) => [s.findingId, s]));

  const findings: PublishPreviewFinding[] = ctx.findings.map((finding) => {
    const anchor = resolveAnchor(finding, ctx.files);
    const live = liveByFinding.get(finding.id);
    const reason = findingReason(finding, anchor, live);
    return {
      finding_id: finding.id,
      publishable: reason == null,
      reason,
      anchor: toPublishAnchor(anchor),
      suggestion_eligible: suggestionEligibility(toNoteFinding(finding), anchor),
      published: live?.state === 'published' ? publishedLink(live) : null,
    };
  });

  return {
    review_id: ctx.review.id,
    provider: ctx.repo.provider,
    mr_iid: ctx.repo.provider === 'gitlab' ? ctx.pr.number : null,
    viewer_can_publish: viewerCanPublish,
    blockers: reviewBlockers(input),
    findings,
  };
}
