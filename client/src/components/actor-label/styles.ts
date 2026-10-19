import type { CSSProperties } from "react";

/** Co-located styles for ActorLabel / ActorAvatar. */
export const s = {
  /** Single-line, CSS-truncated label (full text stays in `title`). */
  label: (maxWidth: number | string): CSSProperties => ({
    display: "inline-block",
    maxWidth,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "bottom",
    color: "var(--text-secondary)",
  }),
  avatarImg: (size: number): CSSProperties => ({
    width: size,
    height: size,
    borderRadius: 99,
    flexShrink: 0,
    objectFit: "cover",
    border: "1px solid var(--border)",
  }),
};
