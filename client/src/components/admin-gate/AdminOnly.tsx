/* AdminOnly — gate for an in-context Admin-only control (AC-33, UI gating table:
   "disabled + Admins only").

   A native `disabled` button drops out of the tab order and hides its reason
   from keyboard users, so for a Member the control stays FOCUSABLE and is
   marked `aria-disabled`, with a VISIBLE "Admins only" hint linked through
   `aria-describedby` (WCAG 2.1 AA — never a hover-only tooltip). Clicks are
   swallowed by `gate.guard(handler)`. Admins get the control untouched.

   Usage:
     <AdminOnly>
       {(gate) => (
         <Button {...gate.controlProps} onClick={gate.guard(addRepo)}>Add repository</Button>
       )}
     </AdminOnly>
*/
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useCan } from "../../lib/permissions";
import { s } from "./styles";

export interface AdminGateControlProps {
  "aria-disabled"?: true;
  "aria-describedby"?: string;
  tabIndex?: 0;
  style?: React.CSSProperties;
}

export interface AdminGate {
  /** The current user may use the control. */
  allowed: boolean;
  /** Spread onto the control (empty object when allowed). */
  controlProps: AdminGateControlProps;
  /** Wrap the control's handler: a no-op (and default-prevented) when not allowed. */
  guard: <A extends unknown[]>(
    handler?: (...args: A) => void,
  ) => ((...args: A) => void) | undefined;
}

export interface AdminOnlyProps {
  children: (gate: AdminGate) => React.ReactNode;
  /** Override the session-derived decision (e.g. an ownership rule). Default: `useCan().isAdmin`. */
  allowed?: boolean;
  /** Hint text; default "Admins only". */
  hint?: string;
  /** Style override for the visible hint. */
  hintStyle?: React.CSSProperties;
}

function preventDefault(args: unknown[]): void {
  const ev = args[0];
  if (ev && typeof ev === "object" && "preventDefault" in ev) {
    (ev as { preventDefault: () => void }).preventDefault();
  }
}

export function AdminOnly({ children, allowed, hint, hintStyle }: AdminOnlyProps) {
  const t = useTranslations("auth");
  const { isAdmin, isPending } = useCan();
  const hintId = React.useId();
  const isAllowed = allowed ?? isAdmin;
  // While the session probe is in flight the control is inert but shows no
  // hint — an Admin would otherwise see "Admins only" flash on every load.
  const showHint = !isAllowed && !(allowed === undefined && isPending);

  const gate: AdminGate = isAllowed
    ? { allowed: true, controlProps: {}, guard: (handler) => handler }
    : {
        allowed: false,
        controlProps: {
          "aria-disabled": true,
          tabIndex: 0,
          ...(showHint ? { "aria-describedby": hintId } : {}),
          style: s.inertControl,
        },
        guard:
          () =>
          (...args) =>
            preventDefault(args),
      };

  return (
    <>
      {children(gate)}
      {showHint && (
        <span id={hintId} style={{ ...s.hint, ...hintStyle }}>
          {hint ?? t("gate.adminsOnly")}
        </span>
      )}
    </>
  );
}

export default AdminOnly;
