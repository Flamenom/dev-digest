import {
  GITLAB_COMMENT_MAX_CHARS,
  repoWebUrl,
  type GitHubClient,
  type GitLabCommentsHost,
  type GitLabDiffNote,
  type HostComment,
  type HostCommentInput,
} from '@devdigest/shared';
import { AppError } from '../../platform/errors.js';
import { hostRepoRef } from '../_shared/repo-ref.js';
import { composeGitLabText, sanitiseFooterName } from './comment-body.js';
import { resolveGitLabTarget, type PersistedFileLike } from './comment-position.js';
import type { DetailRepo } from './detail-service.js';
import { toHostComment } from './gitlab-comment-mapper.js';
import type { SyncLogger } from './sync-service.js';

/**
 * Consumer-shaped access to GitLab for comments. Defined HERE (not imported from
 * `modules/settings`) so the pulls slice never reaches into a sibling module
 * (`no-cross-module`); the container wires it to the token-health gate.
 *
 * `resolve()` → null when no GitLab token is configured; throws the gate's
 * errors (`gitlab_token_insufficient_scope`, `gitlab_token_invalid`,
 * `gitlab_token_unverified`) otherwise.
 */
export interface GitLabCommentAccess {
  resolve: () => Promise<{ host: GitLabCommentsHost; serviceAccount: string } | null>;
}

/** The persisted PR fields comments need (structural — a `pull_requests` row satisfies it). */
export interface CommentsPr {
  id: string;
  number: number;
  headSha: string;
  /** Head SHA the persisted files were fetched at (GitLab only). */
  detailHeadSha: string | null;
}

export type CommentsLogger = SyncLogger;

export interface PrCommentsDeps {
  /** Rejects when GitHub is unavailable (no token / offline). */
  github: () => Promise<GitHubClient>;
  gitlabAccess: GitLabCommentAccess;
  /** The PR's persisted files (the diff the user is commenting on). */
  files: (prId: string) => Promise<PersistedFileLike[]>;
  /** The acting user's display name + email (footer, AC-16), or null. */
  actorName: (userId: string) => Promise<{ name: string | null; email: string | null } | null>;
  /** true ⇒ google auth mode: GitLab posts carry the attribution footer (AC-16/17). */
  footerEnabled: boolean;
  /** Max posted text length (UTF-16 code units); defaults to GitLab's limit. */
  maxChars?: number;
}

/** The comments use case as consumers see it (the container's override slot is typed by this). */
export interface PrComments {
  list(pr: CommentsPr, repo: DetailRepo, log?: CommentsLogger): Promise<HostComment[]>;
  create(
    pr: CommentsPr,
    repo: DetailRepo,
    input: HostCommentInput,
    actorUserId: string | null,
    log?: CommentsLogger,
  ): Promise<HostComment>;
}

const DIFF_OUTDATED_MESSAGE = 'New commits were pushed — reload the diff';

/** `{ code, upstreamStatus }` of an error, by shape — never the error, its message or a body. */
function errorTags(err: unknown): { code: string | null; upstreamStatus: number | null } {
  const e = (err ?? {}) as { code?: unknown; upstreamStatus?: unknown; status?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const status =
    typeof e.upstreamStatus === 'number'
      ? e.upstreamStatus
      : typeof e.status === 'number'
        ? e.status
        : null;
  return { code, upstreamStatus: status };
}

/** An `AppError` (matched by shape, so a duplicate class instance still passes through). */
function isAppError(err: unknown): err is AppError {
  if (err instanceof AppError) return true;
  const e = err as { name?: unknown; code?: unknown; statusCode?: unknown } | null;
  return (
    e != null &&
    e.name === 'AppError' &&
    typeof e.code === 'string' &&
    typeof e.statusCode === 'number'
  );
}

/**
 * Inline PR/MR comments — `GET`/`POST /pulls/:id/comments` for both hosts.
 *
 * - GitHub: proxied live, unchanged behaviour (AC-34).
 * - GitLab: diff-anchored discussions read and written as the workspace service
 *   account, with quick-action neutralisation (AC-13), an attribution footer in
 *   google mode (AC-16), position validation against the persisted diff
 *   (AC-11) and a head check before any write (AC-12).
 *
 * The comment body and footer are NEVER logged.
 */
export class PrCommentsService implements PrComments {
  private readonly maxChars: number;

  constructor(private readonly deps: PrCommentsDeps) {
    this.maxChars = deps.maxChars ?? GITLAB_COMMENT_MAX_CHARS;
  }

  // ---- GET ----------------------------------------------------------------

  async list(pr: CommentsPr, repo: DetailRepo, log?: CommentsLogger): Promise<HostComment[]> {
    const ref = hostRepoRef(repo);
    if (ref.provider === 'gitlab') return this.listGitLab(pr, repo, log);

    let gh: GitHubClient;
    try {
      gh = await this.deps.github();
    } catch (err) {
      log?.warn({ err }, 'GitHub client unavailable; serving no PR comments');
      return [];
    }
    try {
      const comments = await gh.listReviewComments({ owner: repo.owner, name: repo.name }, pr.number);
      return comments.map((c) => ({ ...c, provider: 'github' as const }));
    } catch (err) {
      log?.warn({ err }, 'GitHub review-comments fetch skipped (offline / error)');
      return [];
    }
  }

  /** Any failure (gate, project, network) → `[]` + a secret-free warning (AC-6). */
  private async listGitLab(
    pr: CommentsPr,
    repo: DetailRepo,
    log?: CommentsLogger,
  ): Promise<HostComment[]> {
    const ref = hostRepoRef(repo);
    try {
      const access = await this.deps.gitlabAccess.resolve();
      if (!access) return [];
      const refs = await access.host.getDiffRefs(ref, pr.number);
      const notes = await access.host.listDiffNotes(ref, pr.number);
      const webUrl = repoWebUrl(ref.provider, ref.host, ref.fullName);
      return notes.map((note) =>
        toHostComment(note, {
          currentHeadSha: refs.headSha,
          webUrl,
          iid: pr.number,
          serviceAccount: access.serviceAccount,
        }),
      );
    } catch (err) {
      log?.warn(
        { ...errorTags(err), prId: pr.id },
        'GitLab MR discussions fetch skipped; serving no comments',
      );
      return [];
    }
  }

  // ---- POST ---------------------------------------------------------------

  async create(
    pr: CommentsPr,
    repo: DetailRepo,
    input: HostCommentInput,
    actorUserId: string | null,
    _log?: CommentsLogger,
  ): Promise<HostComment> {
    // AC-14 — the route schema already rejects this; kept so the use case is safe on its own.
    if (input.body.trim().length === 0) {
      throw new AppError('validation_error', 'Comment body must not be empty', 400);
    }
    const ref = hostRepoRef(repo);
    if (ref.provider === 'gitlab') return this.createGitLab(pr, repo, input, actorUserId);
    return this.createGitHub(pr, repo, input);
  }

  /** Same request mapping as before GitLab write support (AC-34); `discussion_id` ignored. */
  private async createGitHub(
    pr: CommentsPr,
    repo: DetailRepo,
    input: HostCommentInput,
  ): Promise<HostComment> {
    let gh: GitHubClient;
    try {
      gh = await this.deps.github();
    } catch {
      throw new AppError('github_unavailable', 'Connect a GitHub token to post comments.', 400);
    }
    try {
      const created = await gh.createReviewComment(
        { owner: repo.owner, name: repo.name },
        pr.number,
        {
          commitId: pr.headSha,
          path: input.path,
          line: input.line,
          ...(input.side ? { side: input.side } : {}),
          body: input.body,
          ...(input.in_reply_to != null ? { inReplyTo: input.in_reply_to } : {}),
        },
      );
      return { ...created, provider: 'github' };
    } catch (err) {
      // The adapter maps host failures itself (AC-33) — keep its code/status.
      if (isAppError(err)) throw err;
      // GitHub rejects comments on lines outside the diff / on closed PRs (422).
      const msg = err instanceof Error ? err.message : 'Failed to post the comment to GitHub.';
      throw new AppError('github_comment_failed', msg, 400, { cause: String(err) });
    }
  }

  /**
   * GitLab post/reply. Every local check runs before ANY GitLab request, in
   * this order: reply shape → text + length (AC-15) → position (AC-11) → token
   * gate (AC-29/23) → current diff refs (AC-12) → discussion lookup for a reply
   * (AC-20) → exactly one write.
   */
  private async createGitLab(
    pr: CommentsPr,
    repo: DetailRepo,
    input: HostCommentInput,
    actorUserId: string | null,
  ): Promise<HostComment> {
    const ref = hostRepoRef(repo);
    const discussionId = input.discussion_id ?? null;

    // 1. A GitLab reply is addressed by discussion id (Q5).
    if (input.in_reply_to != null && discussionId == null) {
      throw new AppError('validation_error', 'discussion_id is required to reply on GitLab', 400);
    }

    // 2. Compose the exact text sent; the limit applies to it (body + footer, Q4).
    let footerName: string | null = null;
    if (this.deps.footerEnabled) {
      const who = actorUserId ? await this.deps.actorName(actorUserId) : null;
      footerName = sanitiseFooterName(who?.name ?? null, who?.email ?? null);
    }
    const text = composeGitLabText(input.body, footerName);
    // UTF-16 code units (`.length`), the unit GitLab's note length validation counts.
    if (text.length > this.maxChars) {
      throw new AppError(
        'comment_too_long',
        `The comment is too long for GitLab (max ${this.maxChars.toLocaleString('en-US')} characters).`,
        400,
      );
    }

    // 3. A new comment must target a line of the persisted diff.
    let target: ReturnType<typeof resolveGitLabTarget> = null;
    if (discussionId == null) {
      target = resolveGitLabTarget(await this.deps.files(pr.id), input.path, input.side, input.line);
      if (!target) {
        throw new AppError(
          'comment_position_invalid',
          'That line is not part of this merge request diff.',
          400,
        );
      }
    }

    // 4. Token gate (no token → fail fast, AC-29; gate errors propagate, AC-23).
    const access = await this.deps.gitlabAccess.resolve();
    if (!access) {
      throw new AppError(
        'gitlab_token_missing',
        'Connect a GitLab token in Settings → API keys to post comments.',
        400,
      );
    }
    const { host, serviceAccount } = access;

    // 5. The diff the user saw must still be the MR's current diff (AC-12).
    const refs = await host.getDiffRefs(ref, pr.number);
    if (pr.detailHeadSha == null || refs.headSha !== pr.detailHeadSha) {
      throw new AppError('comment_diff_outdated', DIFF_OUTDATED_MESSAGE, 409);
    }

    let note: GitLabDiffNote;
    if (discussionId != null) {
      // 6. Reply: the discussion must exist on this MR (AC-20); yields the root id (Q3).
      const discussion = await host.getDiscussion(ref, pr.number, discussionId);
      if (!discussion) {
        throw new AppError(
          'comment_thread_not_found',
          'That comment thread no longer exists on the merge request.',
          404,
        );
      }
      // 7. Exactly one write.
      const added = await host.addDiscussionNote(ref, pr.number, discussion.id, text);
      const hasPosition = added.position.newPath != null || added.position.oldPath != null;
      note = {
        ...added,
        discussionId: discussion.id,
        rootNoteId: discussion.rootNoteId,
        position: hasPosition || !discussion.position ? added.position : discussion.position,
      };
    } else {
      const t = target!;
      // 7. Exactly one write, anchored with the CURRENT refs just read.
      note = await host.createDiffDiscussion(ref, pr.number, {
        body: text,
        position: {
          baseSha: refs.baseSha,
          startSha: refs.startSha,
          headSha: refs.headSha,
          oldPath: t.oldPath,
          newPath: t.newPath,
          oldLine: t.oldLine,
          newLine: t.newLine,
        },
      });
    }

    // 8. The read shape (footer stripped back off for the service account, AC-7).
    return toHostComment(note, {
      currentHeadSha: refs.headSha,
      webUrl: repoWebUrl(ref.provider, ref.host, ref.fullName),
      iid: pr.number,
      serviceAccount,
    });
  }
}
