/* usePublishSelection — per-review, in-memory selection of publishable
   findings (AC-36). Nothing is selected initially and nothing is persisted.
   The effective selection is DERIVED in render as `picked ∩ publishable`, so a
   finding that stops being publishable (published, dismissed, …) drops out
   without an effect; counts and the tri-state are derived too. */
"use client";

import { useState } from "react";
import type { PublishPreviewFindingWithDeprecation } from "@/lib/types";

/** A preview entry — base or deprecated-aware (only id + publishable are read). */
type PublishPreviewFinding = PublishPreviewFindingWithDeprecation;
import { selectionState, type SelectionState } from "./helpers";

export interface PublishSelection {
  /** Selected, still-publishable ids. */
  selected: ReadonlySet<string>;
  /** Selected ids in preview order (the request payload). */
  selectedIds: string[];
  count: number;
  publishableCount: number;
  state: SelectionState;
  isSelected: (findingId: string) => boolean;
  toggle: (findingId: string) => void;
  selectAllPublishable: () => void;
  clear: () => void;
  /** The tri-state control's click: all selected → clear, otherwise select all publishable. */
  toggleAll: () => void;
}

const EMPTY: readonly PublishPreviewFinding[] = [];

export function usePublishSelection(
  previewFindings: readonly PublishPreviewFinding[] | null | undefined,
): PublishSelection {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const entries = previewFindings ?? EMPTY;

  const publishableIds = entries.filter((f) => f.publishable).map((f) => f.finding_id);
  const selectedIds = publishableIds.filter((id) => picked.has(id));
  const selected = new Set(selectedIds);
  const state = selectionState(selectedIds.length, publishableIds.length);

  const toggle = (findingId: string) => {
    if (!publishableIds.includes(findingId)) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(findingId)) next.delete(findingId);
      else next.add(findingId);
      return next;
    });
  };
  const selectAllPublishable = () => setPicked(new Set(publishableIds));
  const clear = () => setPicked(new Set());

  return {
    selected,
    selectedIds,
    count: selectedIds.length,
    publishableCount: publishableIds.length,
    state,
    isSelected: (findingId) => selected.has(findingId),
    toggle,
    selectAllPublishable,
    clear,
    toggleAll: () => (state === "all" ? clear() : selectAllPublishable()),
  };
}
