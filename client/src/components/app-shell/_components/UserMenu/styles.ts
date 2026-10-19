import type { CSSProperties } from "react";
import { USER_NAME_MAX_WIDTH } from "../../constants";

/** Co-located styles for the top-bar identity block (google mode only). */
export const s = {
  root: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
    paddingLeft: 12,
    borderLeft: "1px solid var(--border)",
  },
  who: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    lineHeight: 1.25,
  },
  /** Untrusted display name: plain text, single line, CSS-truncated. */
  name: {
    maxWidth: USER_NAME_MAX_WIDTH,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
  },
  role: {
    fontSize: 11.5,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  },
} satisfies Record<string, CSSProperties>;
