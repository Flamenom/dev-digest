import type { CSSProperties } from "react";

export const s = {
  page: {
    height: "calc(100vh - 52px)",
    overflowY: "auto",
    padding: "28px 32px 48px",
  } satisfies CSSProperties,
  inner: {
    maxWidth: 1080,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  } satisfies CSSProperties,
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
  } satisfies CSSProperties,
  heading: {
    margin: 0,
    fontSize: 22,
    fontWeight: 650,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "baseline",
    gap: 6,
  } satisfies CSSProperties,
  headingRepo: {
    color: "var(--accent)",
    fontSize: 21,
  } satisfies CSSProperties,
  metaLine: {
    marginTop: 6,
    fontSize: 13,
    color: "var(--text-muted)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  droppedNote: {
    color: "var(--warn)",
  } satisfies CSSProperties,
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  } satisfies CSSProperties,
  acceptedCount: {
    fontSize: 13,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  toolbarSpacer: {
    flex: 1,
  } satisfies CSSProperties,
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  } satisfies CSSProperties,
  skeletons: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    marginTop: 8,
  } satisfies CSSProperties,
  centered: {
    display: "grid",
    placeItems: "center",
    minHeight: "60vh",
  } satisfies CSSProperties,
  /** Member empty state: the copy, then the inert CTA with its "Admins only" hint. */
  gatedEmpty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  } satisfies CSSProperties,
  /** An Admin-gated control stacked over its (Member-only) hint. */
  gatedAction: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  } satisfies CSSProperties,
} as const;
