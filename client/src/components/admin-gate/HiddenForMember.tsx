/* HiddenForMember — destructive Admin-only actions (delete/remove) are HIDDEN
   for Members (AC-33). Hidden too while the session probe is in flight (fail
   closed); local mode resolves to Admin, so nothing changes there. */
"use client";

import React from "react";
import { useCan } from "@/lib/hooks/permissions";

export function HiddenForMember({
  children,
  fallback = null,
}: {
  children: React.ReactNode;
  /** Rendered instead for Members (default: nothing). */
  fallback?: React.ReactNode;
}) {
  const { isAdmin } = useCan();
  return <>{isAdmin ? children : fallback}</>;
}

export default HiddenForMember;
