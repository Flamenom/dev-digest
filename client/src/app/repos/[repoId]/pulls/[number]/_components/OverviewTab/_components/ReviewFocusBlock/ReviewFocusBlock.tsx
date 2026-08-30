/* ReviewFocusBlock — the brief's "read these first" reading order, rendered
   below the Intent + Blast grid on the Overview tab. A SectionLabel heading, a
   count badge equal to the number of RENDERED entries (never a model-claimed
   count), and the entries in the persisted order: no client re-sort and no
   dedup, because the model's ordering IS the product (AC-26). Each entry is a
   native <button> — tab-reachable and Enter/Space activable for free (AC-30,
   NFR-5) — that jumps to the finding it came from (AC-28) or, failing that, to
   the file:line in the diff (AC-29). Zero entries still render the heading plus
   an empty state; the section is never omitted (AC-13, AC-31). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, SectionLabel } from "@devdigest/ui";
import type { ReviewFocusEntry } from "@devdigest/shared";
import { s } from "./styles";

export interface ReviewFocusBlockProps {
  /** Entries in the persisted (generation) order — rendered verbatim (AC-26). */
  entries: ReviewFocusEntry[];
  /** Entry carries a `finding_id` → focus that finding in the Findings view (AC-28). */
  onGoToFinding: (findingId: string) => void;
  /** Entry without a finding → jump to the file at that line (AC-29). Page-owned. */
  onGoToFile: (file: string, line?: number) => void;
}

/** Index-qualified so duplicate `path:line` pairs (legal — no dedup) can't collide. */
function entryKey(entry: ReviewFocusEntry, index: number): string {
  return `${entry.path}:${entry.line}:${index}`;
}

function entryRef(entry: ReviewFocusEntry): string {
  return `${entry.path}:${entry.line}`;
}

export function ReviewFocusBlock({ entries, onGoToFinding, onGoToFile }: ReviewFocusBlockProps) {
  const t = useTranslations("brief");
  // The badge reads the rendered list, never a count the generation claimed.
  const count = entries.length;

  return (
    <section>
      <SectionLabel icon="ListChecks">
        {t("focus.title")}
        {count > 0 && (
          <Badge color="var(--accent)" style={s.countBadge}>
            {t("focus.count", { count })}
          </Badge>
        )}
      </SectionLabel>

      <div style={s.card}>
        {count > 0 ? (
          <ul style={s.list}>
            {entries.map((entry, index) => (
              <FocusEntryRow
                key={entryKey(entry, index)}
                entry={entry}
                onGoToFinding={onGoToFinding}
                onGoToFile={onGoToFile}
              />
            ))}
          </ul>
        ) : (
          <p style={s.empty}>{t("focus.empty")}</p>
        )}
      </div>
    </section>
  );
}

/** One entry: `path:line` (mono) + the one-line reason, both always shown (AC-27). */
function FocusEntryRow({
  entry,
  onGoToFinding,
  onGoToFile,
}: {
  entry: ReviewFocusEntry;
  onGoToFinding: (findingId: string) => void;
  onGoToFile: (file: string, line?: number) => void;
}) {
  const t = useTranslations("brief");
  const ref = entryRef(entry);
  const findingId = entry.finding_id;

  const activate = () => {
    if (findingId) onGoToFinding(findingId);
    else onGoToFile(entry.path, entry.line);
  };

  return (
    <li style={s.item}>
      <button
        type="button"
        style={s.itemBtn}
        onClick={activate}
        // The visible dash separator is silent to screen readers — name the
        // two parts explicitly instead (NFR-5).
        aria-label={`${ref} — ${t("focus.reasonLabel")}: ${entry.reason}`}
      >
        <Icon.ChevronRight size={12} style={s.itemIcon} aria-hidden="true" />
        <span className="mono" style={s.itemRef}>
          {ref}
        </span>
        <span style={s.itemReason}>— {entry.reason}</span>
      </button>
    </li>
  );
}

export default ReviewFocusBlock;
