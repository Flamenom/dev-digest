/** Root-dir badge palette — the badge label is the FIRST path segment; when it
    matches a bucket name (specs/docs/insights) it keeps the bucket-keyed tone,
    otherwise NEUTRAL_BADGE. Colour is NEVER the only signal: every badge also
    renders the root dir as a text label (WCAG 2.1 AA). */
export const BUCKET_BADGE: Record<string, { color: string; bg: string }> = {
  specs: { color: "var(--accent-text)", bg: "var(--accent-bg)" },
  docs: { color: "var(--info)", bg: "var(--info-bg)" },
  insights: { color: "var(--warn)", bg: "var(--warn-bg)" },
};

/** Neutral tone for root dirs that are not a bucket name (e.g. "server"). */
export const NEUTRAL_BADGE = { color: "var(--text-secondary)", bg: "var(--bg-hover)" };

export const SKELETON_ROWS = 4;
