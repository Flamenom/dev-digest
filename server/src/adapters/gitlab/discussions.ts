import type {
  GitLabDiffNote,
  GitLabDiffRefs,
  GitLabDiscussionRef,
  GitLabTextPosition,
} from '@devdigest/shared';

/**
 * Anti-corruption layer for GitLab MR discussions (spec
 * `specs/2026-10-20-gitlab-comments.md`, AC-1/AC-2/AC-8–AC-10). Pure functions,
 * no I/O. Everything read here is untrusted host data: it is only reshaped,
 * and shape guards drop malformed entries instead of producing invalid domain
 * objects.
 */

// ---------- vendor shapes (only the fields we read) ----------
export interface RestNotePosition {
  position_type?: string | null;
  base_sha?: string | null;
  start_sha?: string | null;
  head_sha?: string | null;
  old_path?: string | null;
  new_path?: string | null;
  old_line?: number | null;
  new_line?: number | null;
}

export interface RestNote {
  id: number;
  type?: string | null;
  system?: boolean | null;
  body?: string | null;
  author?: { username?: string | null } | null;
  created_at?: string | null;
  position?: RestNotePosition | null;
}

export interface RestDiscussion {
  id: string;
  individual_note?: boolean | null;
  notes?: RestNote[] | null;
}

export interface RestDiffRefs {
  base_sha?: string | null;
  start_sha?: string | null;
  head_sha?: string | null;
}

/** GitLab `position` request body for a `text` diff note. */
export interface ApiTextPosition {
  position_type: 'text';
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  old_line?: number;
  new_line?: number;
}

// ---------- helpers ----------
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const lineOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
const isNoteId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

type NotePosition = GitLabDiffNote['position'];

function mapPosition(p: RestNotePosition | null | undefined): NotePosition | null {
  if (!p || typeof p !== 'object') return null;
  return {
    headSha: str(p.head_sha),
    oldPath: strOrNull(p.old_path),
    newPath: strOrNull(p.new_path),
    oldLine: lineOrNull(p.old_line),
    newLine: lineOrNull(p.new_line),
  };
}

const EMPTY_POSITION: NotePosition = {
  headSha: '',
  oldPath: null,
  newPath: null,
  oldLine: null,
  newLine: null,
};

/** A diff discussion we surface: not an individual note, root is a non-system `text` DiffNote. */
function isTextDiffDiscussion(d: RestDiscussion | null | undefined): boolean {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id) return false;
  if (d.individual_note === true) return false;
  const root = Array.isArray(d.notes) ? d.notes[0] : undefined;
  if (!root || !isNoteId(root.id)) return false;
  if (root.type !== 'DiffNote' || root.system === true) return false;
  return root.position?.position_type === 'text';
}

/**
 * One note → domain note. `fallbackPosition` (the discussion root's) is used when a
 * reply carries no position of its own.
 */
export function mapNote(
  note: RestNote,
  discussionId: string,
  rootNoteId: number,
  fallbackPosition: NotePosition | null = null,
): GitLabDiffNote | null {
  if (!note || !isNoteId(note.id)) return null;
  return {
    id: note.id,
    discussionId,
    rootNoteId,
    author: str(note.author?.username, 'unknown') || 'unknown',
    body: str(note.body),
    createdAt: str(note.created_at),
    position: mapPosition(note.position) ?? fallbackPosition ?? EMPTY_POSITION,
  };
}

// ---------- discussions ----------
/**
 * Raw MR discussions → every note of every diff-anchored, `text`-positioned
 * discussion (AC-1). Individual/overview notes, image/file positions and system
 * notes are excluded. The first note is the thread root (AC-2).
 */
export function mapDiscussions(raw: readonly RestDiscussion[] | null | undefined): GitLabDiffNote[] {
  const out: GitLabDiffNote[] = [];
  for (const d of raw ?? []) {
    if (!isTextDiffDiscussion(d)) continue;
    const notes = d.notes as RestNote[];
    const root = notes[0]!;
    const rootPosition = mapPosition(root.position);
    for (const note of notes) {
      if (!note || note.system === true) continue;
      const mapped = mapNote(note, d.id, root.id, rootPosition);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}

/** A single discussion → existence + root note id (AC-19/AC-20). null ⇒ no usable root note. */
export function mapDiscussionRef(raw: RestDiscussion | null | undefined): GitLabDiscussionRef | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const root = Array.isArray(raw.notes) ? raw.notes[0] : undefined;
  if (!root || !isNoteId(root.id)) return null;
  const position = root.position?.position_type === 'text' ? mapPosition(root.position) : null;
  return { id: raw.id, rootNoteId: root.id, position };
}

/** The first note of a just-created discussion (POST …/discussions response). */
export function mapCreatedDiscussion(raw: RestDiscussion | null | undefined): GitLabDiffNote | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const root = Array.isArray(raw.notes) ? raw.notes[0] : undefined;
  if (!root || !isNoteId(root.id)) return null;
  return mapNote(root, raw.id, root.id);
}

// ---------- diff refs ----------
/** MR `diff_refs` → domain refs; null when any SHA is missing. */
export function mapDiffRefs(raw: RestDiffRefs | null | undefined): GitLabDiffRefs | null {
  const baseSha = strOrNull(raw?.base_sha);
  const startSha = strOrNull(raw?.start_sha);
  const headSha = strOrNull(raw?.head_sha);
  if (!baseSha || !startSha || !headSha) return null;
  return { baseSha, startSha, headSha };
}

/**
 * Domain position → GitLab request `position`. A null `oldLine`/`newLine` is
 * OMITTED (added line ⇒ only `new_line`, removed ⇒ only `old_line`, context ⇒
 * both — AC-9); a renamed file sends distinct old/new paths (AC-10).
 */
export function toApiPosition(p: GitLabTextPosition): ApiTextPosition {
  const out: ApiTextPosition = {
    position_type: 'text',
    base_sha: p.baseSha,
    start_sha: p.startSha,
    head_sha: p.headSha,
    old_path: p.oldPath,
    new_path: p.newPath,
  };
  if (p.oldLine != null) out.old_line = p.oldLine;
  if (p.newLine != null) out.new_line = p.newLine;
  return out;
}
