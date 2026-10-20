/* host-context — the PR's repository host for every FindingCard below it.

   FindingCards are rendered several layers deep (FindingsTab → ReviewRunAccordion
   → FindingsPanel → FindingCard). The intermediate layers only forward strings
   (`repoFullName`/`headSha`), so the host-aware bits — the provider-correct blob
   link (AC-37/38) and the copy-finding offer (AC-38) — travel through
   this context instead. Provided once by FindingsTab; absent → FindingCard keeps
   its legacy GitHub props behaviour. */
"use client";

import React from "react";
import type { HostLinkRepo } from "@/lib/host-urls";

export interface FindingHost {
  /** The PR's repository (provider/host/web_url); null until loaded. */
  repo: HostLinkRepo | null;
  /** Offer "Copy finding" on each card (GitLab); posting is never offered here. */
  offerCopy: boolean;
}

const FindingHostCtx = React.createContext<FindingHost | null>(null);

export function FindingHostProvider({
  value,
  children,
}: {
  value: FindingHost;
  children: React.ReactNode;
}) {
  return <FindingHostCtx.Provider value={value}>{children}</FindingHostCtx.Provider>;
}

export function useFindingHost(): FindingHost | null {
  return React.useContext(FindingHostCtx);
}
