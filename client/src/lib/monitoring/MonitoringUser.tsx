/* MonitoringUser — keeps the Sentry user tag in sync with the session (AC-38).
   Sends the internal user id ONLY (never email / name / avatar). Renders nothing.
   Mounted by `Providers` only when a DSN was baked into the build, so a build
   without monitoring makes no extra session read. */
"use client";

import { useEffect } from "react";
import { useSession } from "../hooks/session";
import { setMonitoringUser } from "./sentry";

export function MonitoringUser() {
  const { data } = useSession();
  const userId = data?.user?.id ?? null;

  useEffect(() => {
    setMonitoringUser(userId);
  }, [userId]);

  return null;
}

export default MonitoringUser;
