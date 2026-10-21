/**
 * Consumer-shaped ports of the `publish` module (spec
 * `specs/2026-10-21-gitlab-publish-findings.md`; plan T5). Application ring:
 * interfaces + domain types + domain errors only — no Container, no Fastify,
 * no Drizzle. The repository (T7) implements `PublishStore`; the container
 * (T10) builds `PublishGitLabAccess` / `PublishAudit` from the GitLab gate and
 * `container.audit`.
 *
 * Every member is a FUNCTION-TYPED PROPERTY, not a method, so
 * `strictFunctionTypes` checks parameters contravariantly (see `host-git.ts`).
 */
import type {
  AuditEventInput,
  FindingKind,
  GitLabCommentsHost,
  GitLabDraftNotesHost,
  HostRepoRef,
  PrStatus,
  PublicationItemState,
  PublicationStatus,
  PublishActor,
  PublishAnchorKind,
  PublishErrorCode,
  RepoProvider,
  Severity,
  TrifectaEvidence,
} from '@devdigest/shared';

// ---------- Persisted inputs ----------

/**
 * The persisted `pr_files` fields the anchor resolver needs. Structurally the
 * same as `pulls/comment-position.ts`'s `PersistedFileLike` plus `changeType`
 * — declared locally so this module never imports a sibling module (onion §9).
 * `pulls/repository.ts`'s `PersistedFile` satisfies it.
 */
export interface PersistedFileLike {
  path: string;
  patch: string | null;
  previousPath: string | null;
  patchOmitted: string | null;
  /** `added | modified | deleted | renamed`, null when unknown. */
  changeType: string | null;
}

/**
 * One finding of the review, as the publish flow needs it. Field names follow
 * the `Finding` contract (snake_case) so it can be handed to `resolveAnchor`
 * and the note composer as-is.
 */
export interface PublishFindingRow {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  file: string;
  start_line: number;
  end_line: number;
  rationale: string;
  suggestion: string | null;
  kind: FindingKind | null;
  evidence: readonly TrifectaEvidence[] | null;
  dismissed_at: Date | null;
}

/** Everything the preview / validation / executor read about one review. */
export interface PublishReviewContext {
  review: {
    id: string;
    workspaceId: string;
    prId: string;
    /** Head SHA of the diff the review actually reviewed (AC-1); null for legacy rows. */
    headSha: string | null;
  };
  pr: {
    id: string;
    /** The MR iid on GitLab (PR number on GitHub). */
    number: number;
    status: PrStatus;
    headSha: string | null;
    /** Head SHA the persisted files were fetched at (AC-5). */
    detailHeadSha: string | null;
  };
  repo: {
    provider: RepoProvider;
    ref: HostRepoRef;
    /** Project web URL, e.g. `https://gitlab.com/group/sub/project` (no trailing slash). */
    webUrl: string;
  };
  findings: PublishFindingRow[];
  /** The persisted GitLab MR diff (`pr_files`) — the ONLY anchor source (AC-9). */
  files: PersistedFileLike[];
}

// ---------- Publication domain ----------

export interface PublicationItemRecord {
  findingId: string;
  /** Send order (AC-25). */
  position: number;
  state: PublicationItemState;
  code: string | null;
  anchorKind: PublishAnchorKind;
  draftId: number | null;
  discussionId: string | null;
  noteId: number | null;
  /** https only (DB CHECK). */
  url: string | null;
  publishedAt: Date | null;
}

export interface PublicationRecord {
  id: string;
  workspaceId: string;
  reviewId: string;
  prId: string;
  createdBy: PublishActor | null;
  status: PublicationStatus;
  code: PublishErrorCode | null;
  message: string | null;
  requested: number;
  drafted: number;
  published: number;
  failed: number;
  generalNotes: number;
  applicableSuggestions: number;
  otherDraftsPublished: number;
  hasSummary: boolean;
  applySuggestions: boolean;
  diffHeadSha: string | null;
  bulkPublishSentAt: Date | null;
  createdAt: Date;
  /** Heartbeat for the 10-minute stale rule (AC-34). */
  updatedAt: Date;
  finishedAt: Date | null;
  /** Ordered by `position`. */
  items: PublicationItemRecord[];
}

/** The live (`pending|drafted|published`) item of a finding, if any (AC-35: at most one). */
export interface FindingLiveState {
  findingId: string;
  publicationId: string;
  publicationStatus: PublicationStatus;
  state: Extract<PublicationItemState, 'pending' | 'drafted' | 'published'>;
  discussionId: string | null;
  noteId: number | null;
  url: string | null;
  publishedAt: Date | null;
  publishedBy: PublishActor | null;
}

export interface CreatePublicationInput {
  workspaceId: string;
  reviewId: string;
  prId: string;
  createdBy: string | null;
  hasSummary: boolean;
  applySuggestions: boolean;
  /** `requested` = items.length (1–50). */
  items: { findingId: string; position: number; anchorKind: PublishAnchorKind }[];
}

export interface PublishedItemLink {
  findingId: string;
  discussionId: string | null;
  noteId: number | null;
  url: string | null;
  publishedAt: Date;
}

/** Terminal (or `unconfirmed`) transition patch for `finish`. */
export interface FinishPublicationPatch {
  status: Exclude<PublicationStatus, 'in_progress'>;
  code: PublishErrorCode | null;
  message: string | null;
  /** Required for published / partially_published / failed; null for `unconfirmed`. */
  finishedAt: Date | null;
  counters?: Partial<{
    drafted: number;
    published: number;
    failed: number;
    generalNotes: number;
    applicableSuggestions: number;
    otherDraftsPublished: number;
  }>;
  diffHeadSha?: string | null;
}

/**
 * Every repository operation the service, executor and reconciler need, named
 * for the operation (onion §5). Workspace scoping is the repository's invariant.
 */
export interface PublishStore {
  loadReviewContext: (workspaceId: string, reviewId: string) => Promise<PublishReviewContext | null>;
  /** Live items for these findings (any publication); missing ⇒ never published / not live. */
  findingStates: (findingIds: readonly string[]) => Promise<FindingLiveState[]>;
  /** The in-progress publication of this PR (any review, any user), if any (AC-6). */
  inProgressForPr: (prId: string) => Promise<{ id: string; reviewId: string } | null>;
  /**
   * Inserts the publication (`in_progress`) and its `pending` items in one
   * transaction — the per-PR lock (AC-22) and the per-finding live guard (AC-35).
   * @throws PublishInProgressError — another in-progress publication holds the PR.
   * @throws FindingAlreadyPublishedError — a selected finding already has a live item.
   */
  createPublication: (input: CreatePublicationInput) => Promise<PublicationRecord>;
  /** Removes a publication (items cascade) — used when the synchronous pre-checks fail (Q1). */
  deletePublication: (publicationId: string) => Promise<void>;
  /** item → `drafted` with its draft id; bumps `drafted` + `updated_at` (AC-25 progress). */
  markItemDrafted: (publicationId: string, findingId: string, draftId: number) => Promise<void>;
  markItemFailed: (publicationId: string, findingId: string, code: PublishErrorCode) => Promise<void>;
  markItemsPublished: (publicationId: string, links: readonly PublishedItemLink[]) => Promise<void>;
  markItemsRolledBack: (publicationId: string, findingIds: readonly string[]) => Promise<void>;
  /**
   * AC-23: items of OTHER publications (ids from deleted stale markers) for these
   * findings that are not `published` → `rolled_back`.
   */
  rollBackLeftoverFindings: (
    publicationIds: readonly string[],
    findingIds: readonly string[],
  ) => Promise<void>;
  setOtherDrafts: (publicationId: string, count: number) => Promise<void>;
  /** Persisted BEFORE the `bulk_publish` request is sent. */
  setBulkPublishSent: (publicationId: string, at: Date) => Promise<void>;
  /** Heartbeat (`updated_at = now()`). */
  touch: (publicationId: string) => Promise<void>;
  /**
   * Conditional (CAS) transition: `UPDATE … WHERE id = ? AND status = ANY(from)`.
   * Returns true only for the caller that won the transition (exactly-once audit).
   */
  finish: (
    publicationId: string,
    from: readonly PublicationStatus[],
    patch: FinishPublicationPatch,
  ) => Promise<boolean>;
  getPublication: (workspaceId: string, publicationId: string) => Promise<PublicationRecord | null>;
  /** Newest first. */
  listForReview: (workspaceId: string, reviewId: string) => Promise<PublicationRecord[]>;
  /**
   * `unconfirmed` rows, plus `in_progress` rows whose `updated_at` < `staleBefore`
   * (AC-34). Scoped to one PR when `prId` is given.
   */
  reconcileCandidates: (filter: { prId?: string; staleBefore: Date }) => Promise<PublicationRecord[]>;
  /**
   * Boot (Q2): every `in_progress` row → `unconfirmed` with code
   * `gitlab_publish_unconfirmed` and `PUBLISH_UNCONFIRMED_MESSAGE` (codes.ts).
   * Returns the number of rows flipped.
   */
  markOrphanedUnconfirmed: () => Promise<number>;
}

// ---------- Outside world ----------

/** The draft-review host plus the diff-refs read (AC-12). */
export type PublishGitLabHost = GitLabDraftNotesHost & Pick<GitLabCommentsHost, 'getDiffRefs'>;

/**
 * Resolves the workspace GitLab token through the token gate. null ⇒ no token
 * stored (`gitlab_token_missing`); gate errors propagate as mapped AppErrors.
 */
export interface PublishGitLabAccess {
  resolve: () => Promise<{ host: PublishGitLabHost; serviceAccount: string } | null>;
}

/** The audit sink; `null` ⇒ local mode (no audit events, AC-42). */
export type PublishAudit = { record: (event: AuditEventInput) => Promise<void> } | null;

export interface PublishClock {
  now: () => Date;
}

/** Structural (pino-compatible) logger. Log codes and ids only — never bodies. */
export interface PublishLogger {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

// ---------- Domain errors (no Fastify, no Drizzle) ----------

/** Another publication of the same PR is in progress (AC-22). */
export class PublishInProgressError extends Error {
  constructor(public readonly runningPublicationId: string) {
    super('A publication of this pull request is already in progress');
    this.name = 'PublishInProgressError';
  }
}

/** One or more selected findings already have a live (pending/drafted/published) item (AC-35). */
export class FindingAlreadyPublishedError extends Error {
  constructor(public readonly findingIds: readonly string[]) {
    super('One or more findings are already published or being published');
    this.name = 'FindingAlreadyPublishedError';
  }
}
