import React from "react";
import { Icon, type IconName } from "../icons";
import { INERT_STYLE, isAriaDisabled, type AriaDisabledProps } from "./aria-disabled";

export function IconBtn({
  icon,
  label,
  size = 30,
  active,
  onClick,
  danger,
  style,
  ...aria
}: {
  icon: IconName;
  label: string;
  size?: number;
  active?: boolean;
  onClick?: () => void;
  danger?: boolean;
} & AriaDisabledProps) {
  const I = Icon[icon];
  const [h, setH] = React.useState(false);
  const inert = isAriaDisabled(aria["aria-disabled"]);
  const hover = h && !inert;
  return (
    <button
      {...aria}
      aria-disabled={inert || undefined}
      title={label}
      aria-label={label}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          return;
        }
        onClick?.();
      }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        width: size,
        height: size,
        display: "inline-grid",
        placeItems: "center",
        borderRadius: 6,
        border: "1px solid transparent",
        background: hover ? "var(--bg-hover)" : active ? "var(--bg-hover)" : "transparent",
        color: danger && hover ? "var(--crit)" : active || hover ? "var(--text-primary)" : "var(--text-secondary)",
        transition: "background .12s, color .12s",
        ...(inert ? INERT_STYLE : {}),
        ...style,
      }}
    >
      <I size={Math.round(size * 0.52)} />
    </button>
  );
}
