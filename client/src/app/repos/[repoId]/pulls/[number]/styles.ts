import type { CSSProperties } from "react";

/** Co-located styles for the PR detail page. */
export const s = {
  /** GitLab token notice wrapper — same column as the tab content below it. */
  tokenNoticeWrap: { padding: "16px 32px 0", maxWidth: 1080, margin: "0 auto" } satisfies CSSProperties,
} as const;
