"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { PrBriefCard } from "./_components/PrBriefCard";
import { IntentCard } from "./_components/IntentCard";
import { BlastCard } from "./_components/BlastCard";
import { ReviewFocusBlock } from "./_components/ReviewFocusBlock";
import { usePrBrief } from "@/lib/hooks/brief";
import { s } from "./styles";

interface OverviewTabProps {
  prBody: string | null | undefined;
  /** PR row uuid (APIs are keyed by uuid; the route is keyed by number). */
  prId: string | null;
  /** Current head SHA — the IntentCard derives its stale badge from it. */
  headSha: string | null | undefined;
  /** "owner/repo" for GitHub deep-links in the BlastCard; null until loaded. */
  repoFullName: string | null;
  /** Blast/brief file:line click — in-app diff jump or GitHub blob fallback (page-owned). */
  onGoToFile: (file: string, line?: number) => void;
  /** Review-focus entry that carries a finding — deep-link into the Findings tab. */
  onGoToFinding: (findingId: string) => void;
}

export function OverviewTab({
  prBody,
  prId,
  headSha,
  repoFullName,
  onGoToFile,
  onGoToFinding,
}: OverviewTabProps) {
  // ONE brief query for the whole tab: the card, the intent card's grounded
  // risks and the review-focus list are three views of the same payload.
  const { data: brief, isLoading: briefLoading } = usePrBrief(prId);

  return (
    <>
      <PrBriefCard prId={prId} brief={brief} isLoading={briefLoading} />

      <div style={s.cardsGrid}>
        <IntentCard
          prId={prId}
          headSha={headSha}
          risks={brief?.risks}
          onGoToRef={onGoToFile}
        />
        <BlastCard prId={prId} repoFullName={repoFullName} onGoToFile={onGoToFile} />
      </div>

      {/* Never omitted — zero entries still render the heading + empty state. */}
      <ReviewFocusBlock
        entries={brief?.review_focus ?? []}
        onGoToFinding={onGoToFinding}
        onGoToFile={onGoToFile}
      />

      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
