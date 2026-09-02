/* EvalCaseEditorModal — screen F of the L06 eval pipeline (spec §10 F).

   Standalone and URL-free on purpose: the caller (the AgentEditor `Evals` tab,
   the `+ New eval case` button, the FindingCard's "Eval case ✓" link) passes the
   case id — or `null` for a new case — the owning agent id and `onClose`. This
   component never reads the route.

   It is a thin container: fetch the case, then hand it to `CaseEditorForm`
   keyed by the case id. The key is load-bearing — it remounts the form when the
   editor is pointed at a different case, so the draft can be seeded in
   `useState` initialisers and there is no props→state `useEffect` anywhere in
   this folder. */
"use client";

import React from "react";
import { Modal } from "@devdigest/ui";
import type { EvalCaseRecord } from "@devdigest/shared";
import { useTranslations } from "next-intl";
import { useEvalCase, useEvalCaseDraft } from "@/lib/hooks/eval";
import { CaseEditorForm } from "./CaseEditorForm";
import { MODAL_WIDTH } from "./constants";
import { s } from "./styles";

export interface EvalCaseEditorModalProps {
  /** Row **uuid** of the case to edit, or `null` to author a new one. */
  caseId: string | null;
  /**
   * Owning agent uuid — `owner_id` of a hand-authored new case. Optional: the
   * "Turn into eval case" path reads the owner off the server-composed draft,
   * because the PR page does not know which agent produced the finding.
   */
  agentId?: string | null;
  /**
   * Finding this case is being authored FROM ("Turn into eval case", §7). The
   * editor opens on the server-composed draft (C24) and writes nothing until
   * Save, which is what keeps the finding card out of its created state until
   * the case actually exists. Ignored when `caseId` is set.
   */
  sourceFindingId?: string | null;
  /** PR whose `["pr-eval-cases", prId]` cache must show the new link on save. */
  prId?: string | null;
  onClose: () => void;
  /**
   * Repo the source finding's PR belongs to. Optional because `input_meta`
   * carries the PR **number** but no repo, and PR routes are
   * `/repos/:repoId/pulls/:number` — without it the provenance note renders
   * without a link instead of guessing an href.
   */
  repoId?: string | null;
  /** Fired with the persisted record after a successful create/update. */
  onSaved?: (record: EvalCaseRecord) => void;
}

export function EvalCaseEditorModal({
  caseId,
  agentId,
  sourceFindingId,
  prId,
  onClose,
  repoId,
  onSaved,
}: EvalCaseEditorModalProps) {
  const t = useTranslations("eval");
  const { data, isLoading } = useEvalCase(caseId);
  // Only one of the two seeds is ever live: `caseId` disables the draft query.
  const fromFinding = caseId ? null : (sourceFindingId ?? null);
  const draft = useEvalCaseDraft(fromFinding);

  // Editing an existing case: do not seed the form from a half-loaded record.
  if (caseId && (isLoading || !data)) {
    return (
      <Modal width={MODAL_WIDTH} title={t("caseEditor.caseTitle", { name: "…" })} onClose={onClose}>
        <div style={s.loading}>{t("dashboard.loading")}</div>
      </Modal>
    );
  }

  if (fromFinding && draft.isLoading) {
    return (
      <Modal width={MODAL_WIDTH} title={t("caseEditor.newCase")} onClose={onClose}>
        <div style={s.loading}>{t("dashboard.loading")}</div>
      </Modal>
    );
  }

  // A draft that cannot be composed (409 not-judged / no-agent / no-patch, §7)
  // is shown here rather than toasted: 4xx stays silent globally, and the user
  // needs to know that nothing was created.
  if (fromFinding && !draft.data) {
    return (
      <Modal width={MODAL_WIDTH} title={t("caseEditor.newCase")} onClose={onClose}>
        <div style={s.loading}>{t("errors.draftUnavailable")}</div>
      </Modal>
    );
  }

  return (
    <CaseEditorForm
      key={data?.id ?? fromFinding ?? "new"}
      record={caseId ? (data ?? null) : null}
      seedDraft={fromFinding ? (draft.data ?? null) : null}
      sourceFindingId={fromFinding}
      prId={prId}
      agentId={agentId}
      repoId={repoId}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
