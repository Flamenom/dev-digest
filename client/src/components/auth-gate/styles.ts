import type { CSSProperties } from "react";

export const s = {
  redirecting: {
    margin: 0,
    padding: 24,
    color: "var(--text-muted)",
    fontSize: 13,
  },
} satisfies Record<string, CSSProperties>;
