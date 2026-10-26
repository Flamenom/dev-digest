/**
 * The publish marker (spec `specs/2026-10-21-gitlab-publish-findings.md`, AC-24,
 * AC-43; plan "Marker technique — decision"). Pure, no I/O.
 *
 * Format — an HTML comment alone on its own line, ids only, lowercase UUIDs:
 *   `<!-- devdigest:publish:v1 w=<workspace> p=<publication> f=<finding> -->`
 *
 * - No user text, no newline, no trailing whitespace: immune to GitLab's note
 *   normalisation (strip `\r`, trim trailing whitespace).
 * - Starts with `<`: never command-shaped, so quick-action neutralisation leaves
 *   it alone. Contains no `@ # ! ~ % & $`, so the mention guard is a no-op on it.
 * - Placed after the content and BEFORE the footer; the footer stays the final
 *   line so `stripAttribution` still matches first on read-back.
 *
 * A parsed marker is only meaningful on a SERVICE-ACCOUNT-authored note/draft —
 * that check belongs to the caller (AC-24: a pasted marker by anyone else is
 * ignored). A marker with another workspace id is returned as-is; the caller
 * decides (AC-23 "other drafts").
 *
 * If GitLab turns out to render or drop the HTML comment (manual verification
 * #9), the fallback is a CommonMark link-reference definition — a change to this
 * file only.
 */

export interface PublishMarkerIds {
  workspaceId: string;
  publicationId: string;
  findingId: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const MARKER_RE = new RegExp(`^<!-- devdigest:publish:v1 w=(${UUID}) p=(${UUID}) f=(${UUID}) -->$`);

function normaliseId(name: string, value: string): string {
  const id = value.toLowerCase();
  if (!UUID_RE.test(id)) throw new Error(`publish marker: ${name} is not a UUID`);
  return id;
}

/** The marker line (no line break). Throws when an id is not a UUID. */
export function buildMarker(ids: PublishMarkerIds): string {
  const w = normaliseId('workspaceId', ids.workspaceId);
  const p = normaliseId('publicationId', ids.publicationId);
  const f = normaliseId('findingId', ids.findingId);
  return `<!-- devdigest:publish:v1 w=${w} p=${p} f=${f} -->`;
}

/** Fixed length of every marker line (UUIDs are fixed-length) — for AC-18 bounds. */
export const MARKER_LINE_LENGTH = buildMarker({
  workspaceId: '00000000-0000-0000-0000-000000000000',
  publicationId: '00000000-0000-0000-0000-000000000000',
  findingId: '00000000-0000-0000-0000-000000000000',
}).length;

function lastMarkerLine(lines: readonly string[]): { index: number; match: RegExpExecArray } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = MARKER_RE.exec(lines[i]!);
    if (m) return { index: i, match: m };
  }
  return null;
}

/** The ids of the LAST exact marker line in `body`, or null. */
export function parseMarker(body: string): PublishMarkerIds | null {
  const found = lastMarkerLine(body.split(/\r?\n/));
  if (!found) return null;
  const [, workspaceId, publicationId, findingId] = found.match;
  return { workspaceId: workspaceId!, publicationId: publicationId!, findingId: findingId! };
}

/**
 * Removes the last exact marker line and the single blank line before it. Every
 * other line is left untouched; a body without a marker is returned unchanged.
 */
export function stripMarker(body: string): string {
  const lines = body.split('\n');
  // Tolerate a `\r` GitLab may have kept; the match itself stays exact.
  const found = lastMarkerLine(lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)));
  if (!found) return body;
  let start = found.index;
  if (start > 0 && /^\r?$/.test(lines[start - 1]!)) start -= 1;
  lines.splice(start, found.index - start + 1);
  return lines.join('\n');
}
