import type { FindingRecord } from "@devdigest/shared";

/** Format a finding's line range ("11" when single-line, else "11-15"). */
export function lineLabel(f: Pick<FindingRecord, "start_line" | "end_line">): string {
  return f.start_line === f.end_line ? `${f.start_line}` : `${f.start_line}-${f.end_line}`;
}

/**
 * Plain-text form of a finding for the clipboard — the read-only hosts'
 * substitute for posting it as a comment (AC-43). Text only: the rationale and
 * suggestion are model output and are copied verbatim, never rendered as HTML.
 */
export function findingClipboardText(
  f: Pick<FindingRecord, "title" | "file" | "start_line" | "end_line" | "rationale" | "suggestion">,
  suggestedFixLabel: string,
): string {
  const parts = [`${f.title}`, `${f.file}:${lineLabel(f)}`, "", f.rationale.trim()];
  if (f.suggestion?.trim()) parts.push("", `${suggestedFixLabel}:`, f.suggestion.trim());
  return parts.join("\n");
}
