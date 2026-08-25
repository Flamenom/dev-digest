"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { IntentCard } from "./_components/IntentCard";
import { BlastCard } from "./_components/BlastCard";
import { s } from "./styles";

interface OverviewTabProps {
  prBody: string | null | undefined;
  /** PR row uuid (APIs are keyed by uuid; the route is keyed by number). */
  prId: string | null;
  /** Current head SHA — the IntentCard derives its stale badge from it. */
  headSha: string | null | undefined;
  /** "owner/repo" for GitHub deep-links in the BlastCard; null until loaded. */
  repoFullName: string | null;
  /** Blast file:line click — in-app diff jump or GitHub blob fallback (page-owned). */
  onGoToFile: (file: string, line?: number) => void;
}

export function OverviewTab({ prBody, prId, headSha, repoFullName, onGoToFile }: OverviewTabProps) {
  return (
    <>
      <div style={s.cardsGrid}>
        <IntentCard prId={prId} headSha={headSha} />
        <BlastCard prId={prId} repoFullName={repoFullName} onGoToFile={onGoToFile} />
      </div>
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
