/* useAdminHint — the read-only + "Admins only" hint wiring shared by list
   screens whose row controls are Admin-only (AC-33): agents Skills/Context tabs,
   skill Context tab.

   `readOnly` is true until the session resolves (fail closed). The hint is
   shown — and linked from the controls via `aria-describedby` — only once we
   KNOW the user is a Member, so an Admin never sees "Admins only" flash while
   the session probe is in flight. Render the hint with <AdminHint hint={…} />. */
"use client";

import React from "react";
import { useCan } from "@/lib/hooks/permissions";

export interface AdminHintState {
  /** Controls are inert (Member, or session still pending). */
  readOnly: boolean;
  /** Id of the visible hint element. */
  hintId: string;
  /** Render the visible hint (Member, session resolved). */
  showHint: boolean;
  /** Spread as `aria-describedby` on each gated control; undefined when no hint. */
  describedBy: string | undefined;
}

export function useAdminHint(): AdminHintState {
  const { isAdmin, isPending } = useCan();
  const hintId = React.useId();
  const readOnly = !isAdmin;
  const showHint = readOnly && !isPending;
  return { readOnly, hintId, showHint, describedBy: showHint ? hintId : undefined };
}

export default useAdminHint;
