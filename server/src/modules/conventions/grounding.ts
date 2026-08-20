import type { ConventionCategory } from '@devdigest/shared';

/**
 * Evidence grounding for convention candidates — the server-side sibling of
 * reviewer-core's grounding gate (same keep-or-drop-with-reason discipline,
 * different input source: sampled clone files instead of a diff).
 *
 * A candidate survives only when its `evidence_path` is one of the files that
 * were actually sent to the model AND its `evidence_snippet` occurs in that
 * file. Everything else is dropped with a reason (surfaced in the scan stats),
 * never thrown.
 */

export type DropReason = 'path-not-sampled' | 'snippet-not-found' | 'empty-snippet';

export interface RawConventionCandidate {
  category: ConventionCategory;
  rule: string;
  evidence_path: string;
  evidence_snippet: string;
  confidence: number;
}

export interface GroundedConvention extends RawConventionCandidate {
  /** 1-based, inclusive; null when the snippet matched only whitespace-tolerantly across reflowed lines. */
  evidence_start_line: number | null;
  evidence_end_line: number | null;
}

export interface GroundingResult {
  kept: GroundedConvention[];
  dropped: { candidate: RawConventionCandidate; reason: DropReason }[];
  /** e.g. "3/5 candidates passed grounding" */
  summary: string;
}

export function groundConventions(
  candidates: RawConventionCandidate[],
  files: ReadonlyMap<string, string>,
): GroundingResult {
  const kept: GroundedConvention[] = [];
  const dropped: GroundingResult['dropped'] = [];

  for (const candidate of candidates) {
    if (candidate.evidence_snippet.trim() === '') {
      dropped.push({ candidate, reason: 'empty-snippet' });
      continue;
    }
    const content = files.get(candidate.evidence_path);
    if (content === undefined) {
      dropped.push({ candidate, reason: 'path-not-sampled' });
      continue;
    }
    const lines = locateSnippet(content, candidate.evidence_snippet);
    if (!lines) {
      dropped.push({ candidate, reason: 'snippet-not-found' });
      continue;
    }
    kept.push({ ...candidate, evidence_start_line: lines.start, evidence_end_line: lines.end });
  }

  return {
    kept,
    dropped,
    summary: `${kept.length}/${candidates.length} candidates passed grounding`,
  };
}

/**
 * Find the snippet in the file and resolve 1-based inclusive line numbers.
 * (a) exact substring match; (b) whitespace-tolerant fallback: a contiguous
 * run of per-line-trimmed file lines equal to the per-line-trimmed snippet
 * lines. No match → null. Leading/trailing blank snippet lines are ignored in
 * both modes.
 */
function locateSnippet(
  content: string,
  snippet: string,
): { start: number; end: number } | null {
  const stripped = snippet.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
  if (stripped === '') return null;

  const exactIdx = content.indexOf(stripped);
  if (exactIdx !== -1) {
    const start = countLines(content, exactIdx);
    return { start, end: start + stripped.split('\n').length - 1 };
  }

  const fileLines = content.split('\n').map((l) => l.trim());
  const snippetLines = stripped.split('\n').map((l) => l.trim());

  for (let i = 0; i <= fileLines.length - snippetLines.length; i++) {
    let match = true;
    for (let j = 0; j < snippetLines.length; j++) {
      if (fileLines[i + j] !== snippetLines[j]) {
        match = false;
        break;
      }
    }
    if (match) return { start: i + 1, end: i + snippetLines.length };
  }
  return null;
}

/** 1-based line number of the character at `index`. */
function countLines(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}
