/* FindingPublishAddon — a FindingCard's header slot for the GitLab publish
   control (AC-36). A real component (stable identity across renders) that
   reads the run's publish state from `FindingPublishProvider`, mounted by
   ReviewPublishSection once the preview allows publishing. No provider (GitHub,
   preview still loading, AC-40 viewer) or no preview entry → renders nothing,
   so the card header is unchanged. */
"use client";

import React from "react";
import type { FindingRecord } from "@devdigest/shared";
import type { PublishPreviewFinding } from "@/lib/types";
import { FindingPublishControl } from "../FindingPublishControl";
import { s } from "./styles";

export interface FindingPublishState {
  /** finding_id → its publish preview entry. */
  entries: ReadonlyMap<string, PublishPreviewFinding>;
  isSelected: (findingId: string) => boolean;
  onToggle: (findingId: string) => void;
  /** Selection is frozen (a publication is in progress, AC-39). */
  disabled: boolean;
}

const FindingPublishCtx = React.createContext<FindingPublishState | null>(null);

export function FindingPublishProvider({
  value,
  children,
}: {
  value: FindingPublishState;
  children: React.ReactNode;
}) {
  return <FindingPublishCtx.Provider value={value}>{children}</FindingPublishCtx.Provider>;
}

export function FindingPublishAddon({ finding }: { finding: FindingRecord }) {
  const ctx = React.useContext(FindingPublishCtx);
  const entry = ctx?.entries.get(finding.id);
  if (!ctx || !entry) return null;
  return (
    <div style={s.root}>
      <FindingPublishControl
        entry={entry}
        title={finding.title}
        checked={ctx.isSelected(finding.id)}
        onToggle={ctx.onToggle}
        disabled={ctx.disabled}
      />
    </div>
  );
}

export default FindingPublishAddon;
