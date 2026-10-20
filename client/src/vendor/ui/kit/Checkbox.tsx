import React from "react";
import { Icon } from "../icons";
import { INERT_STYLE, isAriaDisabled, type AriaDisabledProps } from "../primitives/aria-disabled";

/** REAL controlled checkbox (styled). With `aria-disabled` it stays focusable but ignores activation. */
export function Checkbox({
  checked,
  onChange,
  label,
  style,
  ...aria
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label?: React.ReactNode;
} & AriaDisabledProps) {
  const inert = isAriaDisabled(aria["aria-disabled"]);
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 14,
        color: "var(--text-secondary)",
        cursor: inert ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      <button
        type="button"
        {...aria}
        aria-disabled={inert || undefined}
        role="checkbox"
        aria-checked={checked}
        onClick={(e) => {
          if (inert) {
            e.preventDefault();
            return;
          }
          onChange?.(!checked);
        }}
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          border: "1.5px solid " + (checked ? "var(--accent)" : "var(--border-strong)"),
          background: checked ? "var(--accent)" : "transparent",
          display: "grid",
          placeItems: "center",
          padding: 0,
          ...(inert ? INERT_STYLE : {}),
        }}
      >
        {checked && <Icon.Check size={11} style={{ color: "#fff" }} />}
      </button>
      {label}
    </label>
  );
}
