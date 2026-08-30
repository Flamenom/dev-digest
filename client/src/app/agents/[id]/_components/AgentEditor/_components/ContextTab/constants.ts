export const DRAG_HANDLE_GLYPH = "≡";

/** Root-dir badge palette — the badge label is the FIRST path segment; bucket
    names keep their tone, any other root dir gets NEUTRAL_BADGE. Colour only
    accompanies the text label (WCAG: never colour alone). */
export const BUCKET_BADGE: Record<string, { color: string; bg: string }> = {
  specs: { color: "var(--accent-text)", bg: "var(--accent-bg)" },
  docs: { color: "var(--info)", bg: "var(--info-bg)" },
  insights: { color: "var(--sugg)", bg: "var(--sugg-bg)" },
};

/** Neutral tone for root dirs that are not a bucket name (e.g. "server"). */
export const NEUTRAL_BADGE = { color: "var(--text-secondary)", bg: "var(--bg-hover)" };
