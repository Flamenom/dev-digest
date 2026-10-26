/* FindingCard — ported from findings.jsx (createElement → TSX).
   Severity icon+label, category, file:line, confidence, markdown rationale +
   suggestion, accept/dismiss actions. Accept/dismiss reflect persisted
   timestamps.

   Presentational only: the "Turn into eval case" action is handed down as
   props (`evalCaseLink` / `onOpenEvalCase`) — FindingsPanel owns the query and
   the editor modal, the same way it owns `useFindingAction` (§7). Clicking
   creates nothing: the case is written by the editor's Save, which is why the
   created state can only come from the loaded R2 payload.

   Attribution (AC-46/AC-48): when the payload carries `acted_by`, the latest
   judgement reads "Accepted by / Dismissed by <name>" ("Local user" for the
   seeded user, "—" when unknown). Accept/Dismiss and "Turn into eval case"
   stay enabled for every role (UI gating table). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  Icon,
  SeverityBadge,
  CategoryTag,
  MonoLink,
  ConfidenceNum,
  Button,
  Markdown,
  type Severity,
  type Category,
} from "@devdigest/ui";
import type { EvalCaseLink, FindingRecordWithActor, FindingActionKind } from "@devdigest/shared";
import { ActorLabel } from "@/components/actor-label";
import { SEV_COLOR, SEV_COLOR_FALLBACK } from "./constants";
import { fileHrefFor, latestJudgement, lineLabel } from "./helpers";
import { useFindingHost } from "./host-context";
import { CopyFindingAction } from "./_components/CopyFindingAction";
import { s } from "./styles";

export function FindingCard({
  f,
  focused,
  defaultExpanded,
  onAction,
  pending,
  repoFullName,
  headSha,
  evalCaseLink,
  onOpenEvalCase,
  addon,
}: {
  /** `acted_by` (optional) names who made the latest accept/dismiss (AC-46). */
  f: FindingRecordWithActor;
  focused?: boolean;
  defaultExpanded?: boolean;
  onAction?: (action: FindingActionKind, reply?: string) => void;
  pending?: boolean;
  repoFullName?: string | null;
  headSha?: string | null;
  /** The eval case already created from this finding — joined client-side from
   *  the `GET /pulls/:id/eval-cases` payload, never a field on `FindingRecord`. */
  evalCaseLink?: EvalCaseLink | null;
  /** Open the case editor for this finding — creating nothing on its own. */
  onOpenEvalCase?: () => void;
  /** Optional header slot (e.g. the GitLab publish control), rendered as-is
   *  between the title block and the chevron; it owns its layout and must
   *  contain its own clicks — the header toggles the card. Absent → card unchanged. */
  addon?: React.ReactNode;
}) {
  const t = useTranslations("prReview");
  const hintId = React.useId();
  const host = useFindingHost();
  const [expanded, setExpanded] = React.useState(defaultExpanded ?? false);
  const sevColor = SEV_COLOR[f.severity] ?? SEV_COLOR_FALLBACK;
  const fileHref = fileHrefFor(f, headSha, host, repoFullName);
  const offerCopy = !!host?.offerCopy;
  const accepted = !!f.accepted_at;
  const dismissed = !!f.dismissed_at;
  const muted = accepted || dismissed;
  // A case records a judgement, so an unjudged finding cannot become one
  // (the server independently answers 409 `finding_not_judged`) — AC-7.
  const judged = accepted || dismissed;
  const judgement = latestJudgement(f);

  return (
    <div data-finding-id={f.id} style={s.card(!!focused, sevColor, muted)}>
      <div onClick={() => setExpanded((e) => !e)} style={s.header}>
        <div style={s.badgeWrap}>
          <SeverityBadge severity={f.severity as Severity} compact />
        </div>
        <div style={s.headerMain}>
          <div style={s.titleRow}>
            <span style={s.title(muted, dismissed)}>{f.title}</span>
            <CategoryTag category={f.category as Category} />
            {accepted && <span style={s.acceptedTag}>{t("finding.accepted")}</span>}
            {dismissed && <span style={s.dismissedTag}>{t("finding.dismissed")}</span>}
          </div>
          <div style={s.metaRow}>
            <MonoLink href={fileHref}>
              {f.file}:{lineLabel(f)}
            </MonoLink>
            <ConfidenceNum value={f.confidence} />
            {judgement && f.acted_by !== undefined && (
              <ActorLabel actor={f.acted_by} verb={judgement} style={s.actorLabel} />
            )}
          </div>
        </div>
        {addon}
        <Icon.ChevronDown size={16} style={s.chevron(expanded)} />
      </div>

      {expanded && (
        <div style={s.body}>
          <div style={s.prose}>
            <Markdown>{f.rationale}</Markdown>
          </div>
          {f.suggestion && (
            <div style={s.suggestionWrap}>
              <div style={s.suggestionLabel}>{t("finding.suggestedFix")}</div>
              <div style={s.prose}>
                <Markdown>{f.suggestion}</Markdown>
              </div>
            </div>
          )}

          <div style={s.actions}>
            <Button
              kind="secondary"
              size="sm"
              icon="Check"
              disabled={pending}
              active={accepted}
              onClick={() => onAction?.("accept")}
            >
              {t("finding.accept")}
            </Button>
            <Button
              kind="ghost"
              size="sm"
              icon="X"
              disabled={pending}
              active={dismissed}
              onClick={() => onAction?.("dismiss")}
            >
              {t("finding.dismiss")}
            </Button>
            {/* Designed position: between Learn and Reply to author — both of
                which are still out of scope (spec §19.6), so it lands after
                Dismiss in what actually renders. Both states open the editor in place — the reviewer stays on the
                PR. The created state is driven by the R2 payload alone, so it
                appears only once a case really exists, never on the click. */}
            {evalCaseLink ? (
              <Button
                kind="ghost"
                size="sm"
                icon="FlaskConical"
                title={evalCaseLink.case_name}
                onClick={() => onOpenEvalCase?.()}
              >
                {t("finding.evalCaseCreated")}
              </Button>
            ) : (
              <>
                <Button
                  kind="ghost"
                  size="sm"
                  icon="FlaskConical"
                  disabled={!judged}
                  // A disabled button is not focusable, so the reason must be a
                  // description on the button itself — `title` alone is dropped
                  // once aria-describedby is present, hence both.
                  aria-describedby={judged ? undefined : hintId}
                  title={judged ? undefined : t("finding.evalCaseJudgeFirst")}
                  onClick={() => onOpenEvalCase?.()}
                >
                  {t("finding.turnIntoEvalCase")}
                </Button>
                {!judged && (
                  <span id={hintId} style={s.srOnly}>
                    {t("finding.evalCaseJudgeFirst")}
                  </span>
                )}
              </>
            )}
            {offerCopy && <CopyFindingAction f={f} />}
          </div>
        </div>
      )}
    </div>
  );
}
