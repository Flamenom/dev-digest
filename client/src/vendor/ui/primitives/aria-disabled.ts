import type React from "react";

/**
 * Inert-but-focusable state for a control (WCAG 2.1 AA): the control stays in
 * the tab order, is announced as disabled (`aria-disabled`), may point at a
 * VISIBLE reason (`aria-describedby`), and ignores activation — clicks, and
 * Enter/Space (a native button turns those into clicks). Unlike the native
 * `disabled` attribute it never drops out of the tab order, so the reason
 * stays reachable by keyboard.
 *
 * Spread-compatible with the app's admin gate (`{...gate.controlProps}`).
 */
export interface AriaDisabledProps {
  "aria-disabled"?: boolean | "true" | "false";
  "aria-describedby"?: string;
  tabIndex?: number;
  /** Merged onto the control's root (e.g. the gate's inert look). */
  style?: React.CSSProperties;
}

export function isAriaDisabled(value: AriaDisabledProps["aria-disabled"]): boolean {
  return value === true || value === "true";
}

/** The shared inert look (dimmed, not-allowed cursor). */
export const INERT_STYLE: React.CSSProperties = { opacity: 0.5, cursor: "not-allowed" };
