"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { IntentCard } from "./_components/IntentCard";
import { s } from "./styles";

interface OverviewTabProps {
  prBody: string | null | undefined;
  /** PR row uuid (APIs are keyed by uuid; the route is keyed by number). */
  prId: string | null;
  /** Current head SHA — the IntentCard derives its stale badge from it. */
  headSha: string | null | undefined;
}

export function OverviewTab({ prBody, prId, headSha }: OverviewTabProps) {
  return (
    <>
      <IntentCard prId={prId} headSha={headSha} />
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
