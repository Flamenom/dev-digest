/* FindingsPanel — hide-low-confidence + j/k navigation + FindingCard list,
   wiring the accept/dismiss action hook (A2) and the eval-case actions (L06 §7:
   the PR's eval cases are loaded once and joined to findings client-side, so
   the frozen `ReviewRecord.findings` contract stays untouched).

   "Turn into eval case" opens the editor HERE, on the PR page, and writes
   nothing: the case is created by the modal's Save. That is why the card's
   created state is driven purely by the R2 payload — a finding reaches it only
   once a case actually exists, never on the click. */
"use client";

import React from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Toggle, EmptyState } from "@devdigest/ui";
import type { FindingRecord } from "@devdigest/shared";
import { FindingCard } from "../FindingCard";
import { useFindingAction } from "@/lib/hooks/reviews";
import { usePrEvalCases } from "@/lib/hooks/eval";
import { EvalCaseEditorModal } from "@/components/EvalCaseEditorModal";
import { KEY_TO_ACTION } from "./constants";
import { visibleFindings } from "./helpers";
import { s } from "./styles";

/**
 * What the case editor is open on. A finding that has no case yet is addressed
 * by `findingId` (the editor composes an unsaved draft from it); once a case
 * exists the R2 payload gives its `caseId` and the editor edits the real row.
 */
type EvalCaseTarget = { findingId: string } | { caseId: string };

export function FindingsPanel({
  findings,
  prId,
  repoFullName,
  headSha,
  targetFindingId,
  targetNonce = 0,
}: {
  findings: FindingRecord[];
  prId: string;
  repoFullName?: string | null;
  headSha?: string | null;
  /** Focus + scroll this finding's card (Smart Diff deep-link). The nonce
   *  re-triggers the scroll when the same finding is targeted again. */
  targetFindingId?: string | null;
  targetNonce?: number;
}) {
  const t = useTranslations("prReview");
  const params = useParams<{ repoId: string }>();
  const action = useFindingAction();
  const prEvalCases = usePrEvalCases(prId);
  /** Which finding's case the editor is open on, and whether it exists yet. */
  const [editing, setEditing] = React.useState<EvalCaseTarget | null>(null);
  const [hideLow, setHideLow] = React.useState(false);
  const [focusIdx, setFocusIdx] = React.useState(0);

  const shown = React.useMemo(() => visibleFindings(findings, hideLow), [findings, hideLow]);

  // finding_id → its eval case, derived from the already-loaded R2 payload.
  const evalCaseByFinding = React.useMemo(
    () => new Map((prEvalCases.data ?? []).map((link) => [link.finding_id, link])),
    [prEvalCases.data],
  );

  // Deep-link focus (external DOM sync): set focusIdx to the target's index in
  // `shown` and scroll its card into view. If "hide low confidence" filters the
  // target out, flip the filter off first and finish on the re-run once `shown`
  // includes it. A consumed token keeps later `shown` changes (e.g. the user
  // toggling the filter) from re-scrolling.
  const consumedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!targetFindingId) return;
    const token = `${targetFindingId}:${targetNonce}`;
    if (consumedRef.current === token) return;
    const idx = shown.findIndex((f) => f.id === targetFindingId);
    if (idx === -1) {
      if (hideLow && findings.some((f) => f.id === targetFindingId)) setHideLow(false);
      return;
    }
    consumedRef.current = token;
    setFocusIdx(idx);
    const el = document.querySelector<HTMLElement>(
      `[data-finding-id="${CSS.escape(targetFindingId)}"]`,
    );
    if (el) {
      el.style.scrollMarginTop = "16px";
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [targetFindingId, targetNonce, shown, hideLow, findings]);

  // j/k navigation + a/d shortcuts on the focused finding (keyboard).
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "j") setFocusIdx((i) => Math.min(i + 1, shown.length - 1));
      else if (e.key === "k") setFocusIdx((i) => Math.max(i - 1, 0));
      else if (KEY_TO_ACTION[e.key] && shown[focusIdx]) {
        action.mutate({ findingId: shown[focusIdx]!.id, action: KEY_TO_ACTION[e.key]!, prId });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shown, focusIdx, action, prId]);

  return (
    <div>
      <div style={s.toolbar}>
        <div style={s.toggleGroup}>
          {t("panel.hideLowConfidence")}
          <Toggle on={hideLow} onChange={setHideLow} size={16} />
        </div>
      </div>

      <div style={s.list}>
        {shown.length === 0 ? (
          <EmptyState icon="Filter" title={t("panel.noMatchTitle")} body={t("panel.noMatchBody")} />
        ) : (
          shown.map((f, i) => (
            <FindingCard
              key={f.id}
              f={f}
              focused={i === focusIdx}
              defaultExpanded={i === 0}
              pending={action.isPending}
              repoFullName={repoFullName}
              headSha={headSha}
              onAction={(act) => action.mutate({ findingId: f.id, action: act, prId })}
              evalCaseLink={evalCaseByFinding.get(f.id) ?? null}
              onOpenEvalCase={() => {
                const link = evalCaseByFinding.get(f.id);
                setEditing(link ? { caseId: link.case_id } : { findingId: f.id });
              }}
            />
          ))
        )}
      </div>
      {editing && (
        <EvalCaseEditorModal
          caseId={"caseId" in editing ? editing.caseId : null}
          sourceFindingId={"findingId" in editing ? editing.findingId : null}
          prId={prId}
          repoId={params?.repoId ?? null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
