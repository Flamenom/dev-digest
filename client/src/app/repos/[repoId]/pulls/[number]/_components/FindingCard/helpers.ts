import type { FindingRecord } from "@devdigest/shared";
import { githubBlobUrl } from "@/lib/github-urls";
import { hostBlobUrl } from "@/lib/host-urls";
import type { FindingHost } from "./host-context";

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

/**
 * The finding's file link. Host-aware when a FindingHostProvider is present (the
 * PR page) — `hostBlobUrl` returns null for anything unsafe, so no link renders;
 * without a provider the legacy owner/repo props stay as the GitHub-only
 * fallback. No head SHA → no link.
 */
export function fileHrefFor(
  f: Pick<FindingRecord, "file" | "start_line" | "end_line">,
  headSha: string | null | undefined,
  host: FindingHost | null,
  repoFullName: string | null | undefined,
): string | undefined {
  if (!headSha) return undefined;
  if (host) {
    if (!host.repo) return undefined;
    return hostBlobUrl(host.repo, headSha, f.file, f.start_line, f.end_line) ?? undefined;
  }
  return repoFullName
    ? githubBlobUrl(repoFullName, headSha, f.file, f.start_line, f.end_line)
    : undefined;
}

/**
 * The finding's latest judgement, for the "Accepted by / Dismissed by" label
 * (AC-46: the latest action wins). If both timestamps are somehow set, the
 * newer one wins; unparseable timestamps fall back to "dismissed" precedence.
 */
export function latestJudgement(
  f: Pick<FindingRecord, "accepted_at" | "dismissed_at">,
): "accepted" | "dismissed" | null {
  if (f.accepted_at && f.dismissed_at) {
    return Date.parse(f.accepted_at) > Date.parse(f.dismissed_at) ? "accepted" : "dismissed";
  }
  if (f.dismissed_at) return "dismissed";
  if (f.accepted_at) return "accepted";
  return null;
}
