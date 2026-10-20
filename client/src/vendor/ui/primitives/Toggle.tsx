import React from "react";
import { INERT_STYLE, isAriaDisabled, type AriaDisabledProps } from "./aria-disabled";

export function Toggle({
  on,
  onChange,
  size = 18,
  label,
  style,
  ...aria
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  size?: number;
  /** Accessible name of the switch (when no visible `<label>` wraps it). */
  label?: string;
} & AriaDisabledProps) {
  const inert = isAriaDisabled(aria["aria-disabled"]);
  return (
    <button
      {...aria}
      aria-disabled={inert || undefined}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          return;
        }
        onChange(!on);
      }}
      role="switch"
      aria-checked={on}
      aria-label={label}
      style={{
        width: size * 1.85,
        height: size + 4,
        borderRadius: 99,
        border: "none",
        padding: 2,
        background: on ? "var(--accent)" : "var(--border-strong)",
        transition: "background .15s",
        position: "relative",
        ...(inert ? INERT_STYLE : {}),
        ...style,
      }}
    >
      <span
        style={{
          display: "block",
          width: size,
          height: size,
          borderRadius: 99,
          background: "#fff",
          transform: on ? `translateX(${size * 0.85}px)` : "none",
          transition: "transform .15s",
          boxShadow: "0 1px 3px rgba(0,0,0,.3)",
        }}
      />
    </button>
  );
}
