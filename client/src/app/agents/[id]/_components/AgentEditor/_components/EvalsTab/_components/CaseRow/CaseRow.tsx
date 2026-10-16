/* CaseRow — one eval case in the AgentEditor `Evals` tab (spec §10 E):
   status icon · mono name · sub-line · kind badge · run/edit/delete icons.

   The row is presentational: it renders whichever `CaseResult` the tab hands
   it, so the SAME component shows the persisted `last_run` strip and — while a
   batch is in flight — flips to that batch's live row as the case finishes
   (§19.6). It owns no data and no fetching. */
"use client";

import React from "react";
import { Badge, Icon, IconBtn } from "@devdigest/ui";
import type { EvalCaseRecord } from "@devdigest/shared";
import { EM_DASH, ERROR_CODE_KEYS, STATUS_COLOR, STATUS_ICON } from "../../constants";
import type { CaseResult, CaseStatus } from "../../helpers";
import { s } from "./styles";

/** next-intl's `t` for the `eval` namespace, narrowed to what this file calls. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Accessible name of the status glyph. Colour is never the only signal (§14). */
function statusLabel(t: Translate, status: CaseStatus, errorText: string | null): string {
  switch (status) {
    case "pass":
      return t("evalsTab.passed");
    case "fail":
      return t("evalsTab.failed");
    case "pending":
      return t("evalsTab.running");
    case "errored":
      return errorText ?? t("evalsTab.neverRun");
    default:
      return t("evalsTab.neverRun");
  }
}

/** A server error code rendered in English where we have a message for it. */
function errorText(t: Translate, code: string | null): string | null {
  if (!code) return null;
  const key = ERROR_CODE_KEYS[code];
  return key ? t(key) : code;
}

/** `expected 1, got none · recall 100%` — the row's one-line result summary. */
function subLine(t: Translate, status: CaseStatus, result: CaseResult | null, error: string | null): string {
  if (status === "pending") return t("evalsTab.running");
  if (!result) return t("evalsTab.neverRun");
  const expected = result.expectedCount;
  const produced = result.producedCount;
  const base =
    produced === 0
      ? t("evalsTab.expectedGotNone", { expected })
      : t("evalsTab.expectedGot", { expected, actual: produced ?? EM_DASH });
  const recall = result.recall == null ? "" : t("evalsTab.recallSuffix", { recall: Math.round(result.recall * 100) });
  return error ? `${base}${recall} · ${error}` : `${base}${recall}`;
}

export interface CaseRowProps {
  record: EvalCaseRecord;
  /** `null` = never run. Supplied by the tab, which owns the live/last merge. */
  result: CaseResult | null;
  status: CaseStatus;
  /** Disables the per-row Run while this case (or its batch) is executing. */
  busy: boolean;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  t: Translate;
}

export function CaseRow({ record, result, status, busy, onRun, onEdit, onDelete, t }: CaseRowProps) {
  const StatusIcon = Icon[STATUS_ICON[status]];
  const error = errorText(t, result?.error ?? null);
  const expectations = record.expected_output?.expectations ?? [];
  const kind = record.expected_output?.kind;
  const kindLabel =
    expectations.length === 0
      ? t("evalsTab.badgeEmpty")
      : t(kind === "must_not_flag" ? "caseEditor.kind.mustNotFlag" : "caseEditor.kind.mustFind");

  return (
    <li style={s.row}>
      <span style={s.statusSlot}>
        <StatusIcon
          size={15}
          role="img"
          aria-label={statusLabel(t, status, error)}
          style={{
            color: STATUS_COLOR[status],
            animation: status === "pending" ? "ddspin 1s linear infinite" : undefined,
          }}
        />
      </span>
      <span style={s.nameBox}>
        <span className="mono" style={s.name}>
          {record.name}
        </span>
        <span style={s.sub}>{subLine(t, status, result, error)}</span>
      </span>
      <Badge color={kind === "must_not_flag" ? "var(--text-secondary)" : "var(--accent)"}>{kindLabel}</Badge>
      <span style={s.actions}>
        {/* `IconBtn` has no disabled state (vendored primitive, do-not-touch), so
            a busy row simply drops the handler — the server would answer 409
            `batch_already_running` anyway and 4xx stays silent. */}
        <IconBtn icon="Play" label={t("evalsTab.run")} onClick={busy ? undefined : onRun} />
        <IconBtn icon="Edit" label={t("evalsTab.edit")} onClick={onEdit} />
        <IconBtn icon="Trash" label={t("evalsTab.delete")} onClick={onDelete} danger />
      </span>
    </li>
  );
}
