/** Root-dir badge palette — the badge label is the FIRST path segment; bucket
    names keep their tone, any other root dir gets NEUTRAL_BADGE. Colour PLUS a
    text label (WCAG: never colour alone). */
export const BUCKET_COLORS: Record<string, { color: string; bg: string }> = {
  specs: { color: "var(--info)", bg: "var(--info-bg)" },
  docs: { color: "var(--ok)", bg: "var(--ok-bg)" },
  insights: { color: "var(--sugg)", bg: "var(--sugg-bg)" },
};

/** Neutral tone for root dirs that are not a bucket name (e.g. "server"). */
export const NEUTRAL_COLORS = { color: "var(--text-secondary)", bg: "var(--bg-hover)" };

export const DRAG_HANDLE_GLYPH = "≡";
