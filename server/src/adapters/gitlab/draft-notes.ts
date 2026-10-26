import { createHash } from 'node:crypto';
import type { GitLabDraftNote, GitLabDraftPosition, GitLabMrDiffVersion, GitLabMrNote } from '@devdigest/shared';
import { toApiPosition, type ApiTextPosition, type RestDiscussion } from './discussions.js';

/**
 * Anti-corruption layer for GitLab MR draft notes (spec
 * `specs/2026-10-21-gitlab-publish-findings.md`, AC-9/AC-11/AC-23/AC-26). Pure
 * functions, no network I/O. Host data is untrusted: shape guards drop malformed
 * entries instead of producing invalid domain objects.
 */

// ---------- vendor shapes (only the fields we read / send) ----------
export interface RestDraftNote {
  id?: unknown;
  note?: unknown;
}

/** One end of a GitLab `line_range` (request body). */
export interface ApiLineRangeEnd {
  line_code: string;
  type: 'new' | null;
  old_line?: number;
  new_line?: number;
}

/** GitLab `position` request body for a draft note — a text position, optionally multi-line. */
export interface ApiDraftPosition extends ApiTextPosition {
  line_range?: { start: ApiLineRangeEnd; end: ApiLineRangeEnd };
}

/** One entry of `GET …/merge_requests/:iid/versions` (only the fields we read). */
export interface RestDiffVersion {
  id?: unknown;
  head_commit_sha?: unknown;
  base_commit_sha?: unknown;
  start_commit_sha?: unknown;
  created_at?: unknown;
}

/** `GET …/merge_requests/:iid/versions/:id` — the version plus its file diffs. */
export interface RestDiffVersionDetail extends RestDiffVersion {
  diffs?: unknown;
}

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

// ---------- draft notes ----------
/** A raw draft note → domain draft; null when the id is not a positive integer or `note` is not a string. */
export function mapDraftNote(raw: RestDraftNote | null | undefined): GitLabDraftNote | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!isPositiveInt(raw.id) || typeof raw.note !== 'string') return null;
  return { id: raw.id, note: raw.note };
}

/** A raw draft-note list → the well-formed drafts (malformed entries dropped). */
export function mapDraftNotes(raw: readonly (RestDraftNote | null)[] | null | undefined): GitLabDraftNote[] {
  const out: GitLabDraftNote[] = [];
  for (const d of raw ?? []) {
    const mapped = mapDraftNote(d);
    if (mapped) out.push(mapped);
  }
  return out;
}

// ---------- MR diff versions (outdated-review publish) ----------
const isSha = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * A raw MR diff version → domain version; null when the id is not a positive
 * integer or any of the three SHAs is not a non-empty string. A non-string
 * `created_at` becomes `''` (it is informational only).
 */
export function mapDiffVersion(raw: RestDiffVersion | null | undefined): GitLabMrDiffVersion | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!isPositiveInt(raw.id)) return null;
  if (!isSha(raw.head_commit_sha) || !isSha(raw.base_commit_sha) || !isSha(raw.start_commit_sha)) return null;
  return {
    id: raw.id,
    headSha: raw.head_commit_sha,
    baseSha: raw.base_commit_sha,
    startSha: raw.start_commit_sha,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
  };
}

/** A raw version list → the well-formed versions, host order kept (malformed entries dropped). */
export function mapDiffVersions(raw: readonly (RestDiffVersion | null)[] | null | undefined): GitLabMrDiffVersion[] {
  const out: GitLabMrDiffVersion[] = [];
  for (const v of raw ?? []) {
    const mapped = mapDiffVersion(v);
    if (mapped) out.push(mapped);
  }
  return out;
}

// ---------- all MR notes ----------
/**
 * Raw MR discussions → every non-system note of every discussion, diff AND
 * general (individual notes included) — AC-26 reads published notes back by
 * marker. Contrast `mapDiscussions`, which keeps text diff discussions only.
 */
export function mapMrNotes(raw: readonly RestDiscussion[] | null | undefined): GitLabMrNote[] {
  const out: GitLabMrNote[] = [];
  for (const d of raw ?? []) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id) continue;
    if (!Array.isArray(d.notes)) continue;
    for (const n of d.notes) {
      if (!n || typeof n !== 'object' || !isPositiveInt(n.id) || n.system === true) continue;
      const username = n.author?.username;
      out.push({
        id: n.id,
        discussionId: d.id,
        author: typeof username === 'string' && username ? username : 'unknown',
        body: typeof n.body === 'string' ? n.body : '',
        system: false,
      });
    }
  }
  return out;
}

// ---------- position ----------
/**
 * GitLab `line_code` of a diff line: `sha1(newPath)_<oldLine>_<newLine>`, an
 * absent side left empty.
 */
export function gitlabLineCode(newPath: string, oldLine: number | null, newLine: number | null): string {
  const hash = createHash('sha1').update(newPath).digest('hex');
  return `${hash}_${oldLine ?? ''}_${newLine ?? ''}`;
}

function lineRangeEnd(
  newPath: string,
  end: { oldLine: number | null; newLine: number | null },
): ApiLineRangeEnd {
  const out: ApiLineRangeEnd = {
    line_code: gitlabLineCode(newPath, end.oldLine, end.newLine),
    // Added line (new side only) ⇒ 'new'; a context line (both sides) ⇒ null.
    type: end.oldLine == null && end.newLine != null ? 'new' : null,
  };
  if (end.oldLine != null) out.old_line = end.oldLine;
  if (end.newLine != null) out.new_line = end.newLine;
  return out;
}

/**
 * Domain draft position → GitLab request `position` (AC-11). The single-line
 * part is `toApiPosition` (null lines omitted, renamed file ⇒ distinct paths);
 * with `lineRange`, a `line_range` with both ends is added.
 *
 * The `line_range` shape (`line_code` + `type` per end) is the least-documented
 * part of GitLab's API — keep it in THIS function only. Verified manually (plan
 * manual verification #4; see gitlab-org/gitlab#571619).
 */
export function toApiDraftPosition(p: GitLabDraftPosition): ApiDraftPosition {
  const out: ApiDraftPosition = toApiPosition(p);
  if (p.lineRange) {
    out.line_range = {
      start: lineRangeEnd(p.newPath, p.lineRange.start),
      end: lineRangeEnd(p.newPath, p.lineRange.end),
    };
  }
  return out;
}
