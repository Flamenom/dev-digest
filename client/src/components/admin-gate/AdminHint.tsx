/* AdminHint — the VISIBLE reason a list's controls are aria-disabled for a
   Member (WCAG 2.1 AA: described-by target, never hover-only). Pair with
   `useAdminHint()`; renders nothing when the hint is not to be shown. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { AdminHintState } from "./useAdminHint";
import { s } from "./styles";

export interface AdminHintProps {
  hint: Pick<AdminHintState, "hintId" | "showHint">;
  /** Custom reason; default "Admins only". */
  children?: React.ReactNode;
  /** Style override (merged over the default block hint look). */
  style?: React.CSSProperties;
}

export function AdminHint({ hint, children, style }: AdminHintProps) {
  const t = useTranslations("auth");
  if (!hint.showHint) return null;
  return (
    <p id={hint.hintId} style={{ ...s.blockHint, ...style }}>
      {children ?? t("gate.adminsOnly")}
    </p>
  );
}

export default AdminHint;
