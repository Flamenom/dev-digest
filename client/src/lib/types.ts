/**
 * Shared contract types re-exported from @devdigest/shared (single source of
 * truth). F2 imports these rather than redefining them.
 *
 * F1 (@devdigest/shared) currently exports all the platform/findings/brief/
 * knowledge/trace contracts we need for the scaffolding screens, so there are
 * NO local placeholders required at this time. If a feature agent's contract is
 * not yet exported, add a placeholder below marked
 * `// TODO: reconcile with @devdigest/shared`.
 */
export type {
  Settings,
  SettingsUpdate,
  ConnTestProvider,
  ConnTestResult,
  SecretsStatus,
  FeatureModelId,
  FeatureModelChoice,
  FeatureModelDef,
  Provider,
  ModelInfo,
  Repo,
  RepoInput,
  PrMeta,
  PrDetail,
  PrFile,
  PrCommit,
  PrReviewComment,
  PrStatus,
  SpecFile,
  IndexStatus,
} from "@devdigest/shared";

export type { Review, Finding, Severity, Verdict } from "@devdigest/shared";
export type { PrBrief, SmartDiff } from "@devdigest/shared";

// Repository hosts — GitHub + GitLab (contracts/repo-host.ts). Additive "*Host"
// supersets of the platform contracts above.
export type {
  RepoProvider,
  RepoHost,
  RepoSyncState,
  RepoWithHost,
  PrMetaHost,
  PrFileHost,
  PrFileChangeType,
  PrPatchOmitted,
  PrDetailHost,
  IssueMetaHost,
  PrSyncTrigger,
  PrListSync,
  PrListPage,
  PrSyncStartResult,
  PrSyncDoneEvent,
  ConnTestProviderHost,
  ConnTestRequestHost,
  ConnTestResultHost,
  SecretsStatusHost,
  HostErrorCode,
} from "@devdigest/shared";

// Host comments — GitLab phase 2: inline comments + replies, GitLab token health
// (contracts/host-comments.ts, spec 2026-10-20-gitlab-comments).
export type {
  HostComment,
  HostCommentInput,
  GitLabTokenHealth,
  SecretsStatusWithHealth,
  ConnTestResultWithCode,
} from "@devdigest/shared";

// Publish findings to a GitLab MR (contracts/review-publish.ts,
// spec 2026-10-21-gitlab-publish-findings).
export type {
  PublishPreview,
  PublishPreviewFinding,
  PublishBlocker,
  Publication,
  PublicationItem,
  PublishRequest,
  PublishRequestInput,
  OtherDraftsCount,
  PublishErrorCode,
} from "@devdigest/shared";

import type { HostCommentInput } from "@devdigest/shared";

/** The reply field of a host comment post: a GitHub reply sets `in_reply_to`
 *  (root comment id), a GitLab reply sets `discussion_id` — never both (the
 *  `HostCommentInput` refine, enforced here at the type level). Neither ⇒ a new thread. */
export type HostCommentReplyTarget =
  | { in_reply_to?: HostCommentInput["in_reply_to"]; discussion_id?: never }
  | { discussion_id?: HostCommentInput["discussion_id"]; in_reply_to?: never };

/** Client-side body of POST /pulls/:id/comments, derived from the shared `HostCommentInput`. */
export type HostCommentPostInput = Omit<HostCommentInput, "in_reply_to" | "discussion_id"> &
  HostCommentReplyTarget;

/** UI-only view model for a PR list row (derives display fields from PrMeta). */
export interface PrRowView {
  number: number;
  title: string;
  author: string;
  size: "S" | "M" | "L";
  sizeLines: string;
  score: number;
  findings: { CRITICAL: number; WARNING: number; SUGGESTION: number };
  status: "needs_review" | "reviewed" | "stale";
  updated: string;
}
