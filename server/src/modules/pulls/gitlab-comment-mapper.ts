import type { GitLabDiffNote, HostComment } from '@devdigest/shared';
import { stripAttribution } from '../_shared/gitlab-note-text.js';
import { stripMarker } from '../_shared/publish-marker.js';

export interface GitLabCommentContext {
  /** The MR's current head SHA; a note anchored elsewhere is outdated (AC-4). */
  currentHeadSha: string;
  /** Project web URL, e.g. `https://gitlab.com/group/sub/project`. */
  webUrl: string;
  /** MR iid. */
  iid: number;
  /** Username of the service account the stored token authenticates as (AC-7). */
  serviceAccount: string | null;
}

/**
 * Pure: one GitLab diff note → the host-neutral read shape (spec AC-2 – AC-5,
 * AC-7).
 *
 * - AC-3: `new_line` set → `RIGHT`@new_line; only `old_line` → `LEFT`@old_line.
 * - AC-4: anchored at another head → `is_outdated: true`, `line: null`
 *   (`original_line` keeps the anchored line).
 * - AC-5: `html_url` = `<web_url>/-/merge_requests/<iid>#note_<id>`.
 * - AC-2: the root note has `in_reply_to_id: null`; later notes point at the root.
 * - AC-7: the service account's exact trailing footer → stripped body + attribution.
 * - Publish AC-43 (`specs/2026-10-21-gitlab-publish-findings.md`): on a
 *   service-account note the publish marker is stripped too, AFTER the footer
 *   (the footer is the final line). Other authors' notes are left unchanged.
 */
export function toHostComment(note: GitLabDiffNote, ctx: GitLabCommentContext): HostComment {
  const pos = note.position;
  const right = pos.newLine != null;
  const anchoredLine = right ? pos.newLine : pos.oldLine;
  const outdated = pos.headSha !== ctx.currentHeadSha;
  const isServiceAccount = ctx.serviceAccount != null && note.author === ctx.serviceAccount;
  const stripped = stripAttribution(note.body, isServiceAccount);
  const body = isServiceAccount ? stripMarker(stripped.body) : stripped.body;
  const attribution = stripped.attribution;
  return {
    id: note.id,
    path: pos.newPath ?? pos.oldPath ?? '',
    line: outdated ? null : anchoredLine,
    original_line: anchoredLine,
    side: right ? 'RIGHT' : 'LEFT',
    body,
    user: note.author,
    created_at: note.createdAt,
    html_url: `${ctx.webUrl}/-/merge_requests/${ctx.iid}#note_${note.id}`,
    in_reply_to_id: note.id === note.rootNoteId ? null : note.rootNoteId,
    is_outdated: outdated,
    discussion_id: note.discussionId,
    provider: 'gitlab',
    devdigest_attribution: attribution,
  };
}
