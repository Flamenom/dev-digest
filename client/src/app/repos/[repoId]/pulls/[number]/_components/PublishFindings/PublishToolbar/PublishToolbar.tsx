/* PublishToolbar — the per-review "Select all publishable" tri-state control
   and the "Publish N to GitLab" button (AC-36, AC-37). Presentational: the
   selection comes from `usePublishSelection`, the blocker notice from
   `PublishBlockerNotice`.

   Disabled controls use `aria-disabled` (focusable, announced, activation
   ignored) rather than the native attribute, so the button's
   `aria-describedby` → blocker notice stays reachable by keyboard. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@devdigest/ui";
import { ariaChecked, type SelectionState } from "../helpers";
import { s } from "./styles";

export interface PublishToolbarProps {
  /** Tri-state of the selection (`usePublishSelection().state`). */
  state: SelectionState;
  /** Selected finding count (N). */
  count: number;
  /** Publishable findings in the review — 0 makes "Select all" inert. */
  publishableCount: number;
  onToggleAll: () => void;
  onPublish: () => void;
  /** Id of the review-level blocker notice; set ⇒ the button is disabled and described by it. */
  blockerNoticeId?: string | null;
  /** A publication is in progress on this PR — selection and publish are inert (AC-39). */
  busy?: boolean;
}

export function PublishToolbar({
  state,
  count,
  publishableCount,
  onToggleAll,
  onPublish,
  blockerNoticeId,
  busy = false,
}: PublishToolbarProps) {
  const t = useTranslations("prHost.publish");
  const selectInert = busy || publishableCount === 0;
  const publishInert = busy || count === 0 || !!blockerNoticeId;

  return (
    <div style={s.bar}>
      <button
        type="button"
        role="checkbox"
        aria-checked={ariaChecked(state)}
        aria-disabled={selectInert || undefined}
        onClick={() => {
          if (!selectInert) onToggleAll();
        }}
        style={s.selectAll(selectInert)}
      >
        <span style={s.box(state)} aria-hidden>
          {state === "all" && <Icon.Check size={11} />}
          {state === "some" && <span style={s.dash} />}
        </span>
        {t("selectAll")}
      </button>
      <Button
        kind="primary"
        size="sm"
        icon="Upload"
        aria-disabled={publishInert || undefined}
        aria-describedby={blockerNoticeId || undefined}
        onClick={() => {
          if (!publishInert) onPublish();
        }}
        style={publishInert ? s.inert : undefined}
      >
        {t("publishButton", { count })}
      </Button>
    </div>
  );
}

export default PublishToolbar;
