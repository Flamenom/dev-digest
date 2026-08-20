import type { IntentConfidence, IntentDetail, IntentSource, StoredIntentDetail } from '@devdigest/shared';
import { MAX_EXTERNAL_URLS, MAX_REPO_DOCS } from './constants.js';

/**
 * Pure helpers for the intent classifier: source extraction from the PR body,
 * hunk-header projection (diff bodies never leave the server), deterministic
 * confidence, and the stored-row → API-detail mapping.
 */

/** Explicit issue link: `closes|fixes|resolves #N` (first match wins). */
export function extractIssueRef(body: string | null | undefined): number | undefined {
  const m = (body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return m?.[1] ? Number(m[1]) : undefined;
}

/** Repo-relative doc mentions: `specs/*.md` / `docs/*.md` paths (deduped, capped). */
export function extractRepoDocPaths(body: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s(<[`"'])((?:specs|docs)\/[\w./-]+\.md)/gi;
  for (const m of (body ?? '').matchAll(re)) {
    const path = m[1]!;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_REPO_DOCS) break;
  }
  return out;
}

/** http(s) URLs in the body (deduped, capped, trailing punctuation stripped). */
export function extractExternalUrls(body: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of (body ?? '').matchAll(/https?:\/\/[^\s<>)\]"']+/gi)) {
    const url = m[0]!.replace(/[.,;:!?]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_EXTERNAL_URLS) break;
  }
  return out;
}

/**
 * `@@ -a,b +c,d @@` hunk headers of a stored patch — the ONLY part of a diff
 * the classifier ever sees (the trailing section-heading fragment is code
 * content and is stripped). Empty/absent patch → [] (path-only rendering).
 */
export function hunkHeadersFromPatch(patch: string | null | undefined): string[] {
  if (!patch) return [];
  const headers: string[] = [];
  for (const line of patch.split('\n')) {
    const m = line.match(/^@@ [^@]*@@/);
    if (m) headers.push(m[0]);
  }
  return headers;
}

/**
 * Deterministic confidence — never model-self-reported. `low` when the PR body
 * is empty AND nothing was fetched, or when ANY referenced source is
 * unavailable; else `high`.
 */
export function computeConfidence(
  body: string | null | undefined,
  sources: IntentSource[],
): IntentConfidence {
  const bodyEmpty = !body || body.trim().length === 0;
  const anyFetched = sources.some((s) => s.status === 'fetched');
  const anyUnavailable = sources.some((s) => s.status === 'unavailable');
  if ((bodyEmpty && !anyFetched) || anyUnavailable) return 'low';
  return 'high';
}

/** Stored row → API detail; `stale` = the PR head moved since classification. */
export function toIntentDetail(stored: StoredIntentDetail, pullHeadSha: string): IntentDetail {
  return { ...stored, stale: stored.head_sha !== pullHeadSha };
}
