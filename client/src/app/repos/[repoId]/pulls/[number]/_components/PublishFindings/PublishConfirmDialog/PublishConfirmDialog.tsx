/* PublishConfirmDialog — the modal confirm step of a publish (AC-38). Shows
   `!<iid>`, the per-severity and general-comment counts, the "Make code
   suggestions applicable" toggle (default off, hidden when none eligible),
   the other-drafts warning (never disables Publish), an optional summary with
   a live counter, the google-mode attribution note, and Publish / Cancel.

   Built on the design-system `Modal` (focus trap, Esc, focus restore to the
   trigger). Owns its two data hooks: the read-only other-drafts count (one
   GitLab list request while open) and the publish mutation (local error
   channel — the failure renders inline, once). */
"use client";

import React, { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, Modal, Toggle } from "@devdigest/ui";
import { PUBLISH_SUMMARY_MAX_CHARS } from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import { useCan } from "@/lib/hooks/permissions";
import { useCreatePublication, useOtherDraftsCount } from "@/lib/hooks/publish";
import type { Publication } from "@/lib/types";
import { RERUN_ERROR_CODES } from "../constants";
import { knownPublishCode, summarizeSelection, type SelectedFinding } from "../helpers";
import { s } from "./styles";

export interface PublishConfirmDialogProps {
  reviewId: string;
  /** The MR's iid (`!<iid>`); null renders the title without a reference. */
  mrIid: number | null;
  /** The selected findings, in preview order (see `selectedFindings`). */
  selected: readonly SelectedFinding[];
  onClose: () => void;
  /** The `202` publication — the caller switches to the progress view. */
  onPublished: (publication: Publication) => void;
  /** Offered when the publish is rejected because the review's diff is outdated (AC-12). */
  onRerun?: () => void;
}

export function PublishConfirmDialog({ reviewId, mrIid, selected, onClose, onPublished, onRerun }: PublishConfirmDialogProps) {
  const t = useTranslations("prHost.publish");
  const { mode } = useCan();
  const otherDrafts = useOtherDraftsCount(reviewId);
  const create = useCreatePublication(reviewId, { errorChannel: "local" });
  const [summary, setSummary] = useState("");
  const [applySuggestions, setApplySuggestions] = useState(false);
  const summaryId = useId();
  const counterId = useId();

  const { bySeverity, general, suggestionEligible } = summarizeSelection(selected);
  const otherCount = otherDrafts.data?.other_drafts;
  const errorCode = create.error instanceof ApiError ? create.error.code : undefined;
  const known = knownPublishCode(errorCode);

  const publish = () => {
    if (create.isPending) return;
    create.mutate(
      {
        finding_ids: selected.map((f) => f.entry.finding_id),
        summary: summary.trim() ? summary : undefined,
        apply_suggestions: suggestionEligible > 0 && applySuggestions,
      },
      { onSuccess: onPublished },
    );
  };

  const footer = (
    <div style={s.footer}>
      <Button kind="secondary" onClick={onClose}>
        {t("dialog.cancel")}
      </Button>
      <Button kind="primary" icon="Upload" loading={create.isPending} onClick={publish}>
        {t("dialog.publish")}
      </Button>
    </div>
  );

  return (
    <Modal
      width={560}
      title={mrIid != null ? t("dialog.title", { iid: mrIid }) : t("publishButton", { count: selected.length })}
      onClose={onClose}
      footer={footer}
    >
      <div style={s.body}>
        <div style={s.counts}>
          {t("dialog.counts", {
            critical: bySeverity.CRITICAL,
            warning: bySeverity.WARNING,
            suggestion: bySeverity.SUGGESTION,
          })}
        </div>
        {general > 0 && <div>{t("dialog.general", { count: general })}</div>}

        {suggestionEligible > 0 && (
          <div style={s.toggleRow}>
            <Toggle on={applySuggestions} onChange={setApplySuggestions} label={t("dialog.applicable")} />
            <span>{t("dialog.applicable")}</span>
            <span style={s.muted}>{t("dialog.applicableCount", { count: suggestionEligible })}</span>
          </div>
        )}

        {otherCount === null && <Warning text={t("dialog.otherDraftsUnknown")} />}
        {otherCount != null && otherCount > 0 && <Warning text={t("dialog.otherDrafts", { count: otherCount })} />}

        <div style={s.field}>
          <label htmlFor={summaryId} style={s.label}>
            {t("dialog.summary")}
          </label>
          <textarea
            id={summaryId}
            value={summary}
            rows={4}
            maxLength={PUBLISH_SUMMARY_MAX_CHARS}
            aria-describedby={counterId}
            onChange={(e) => setSummary(e.target.value)}
            style={s.textarea}
          />
          <span id={counterId} style={s.counter}>
            {t("dialog.summaryCounter", { count: summary.length.toLocaleString("en") })}
          </span>
        </div>

        {mode === "google" && <div style={s.muted}>{t("dialog.googleNote")}</div>}

        {create.isError && (
          <div role="alert" style={s.error}>
            <span>{known ? t(`code.${known}`) : create.error.message}</span>
            {known && RERUN_ERROR_CODES.has(known) && onRerun && (
              <Button kind="secondary" size="sm" icon="RefreshCw" onClick={onRerun}>
                {t("rerun")}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <div role="note" style={s.warning}>
      <span style={s.warningIcon} aria-hidden>
        <Icon.AlertTriangle size={14} />
      </span>
      <span>{text}</span>
    </div>
  );
}

export default PublishConfirmDialog;
