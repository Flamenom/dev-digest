/* ConventionCard — one extracted candidate: category badge + rule title
   (inline-editable), evidence snippet with `path:lines` and a host ↗ link
   to the evidence lines, confidence bar,
   Accept / Reject actions (FindingCard's accept/dismiss idiom: active state on
   the buttons, 0.6-opacity muting for rejected cards).
   Multi-user (AC-33): Accept / Reject and the rule-edit IconBtn are
   aria-disabled for a Member; Accept / Reject share one visible "Admins only"
   hint. Local mode resolves to Admin. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, IconBtn, ProgressBar, TextInput } from "@devdigest/ui";
import type { Convention } from "@devdigest/shared";
import { hostLabelKey } from "@/lib/host-urls";
import { useUpdateConvention } from "@/lib/hooks/conventions";
import { useCan } from "@/lib/hooks/permissions";
import { AdminOnly } from "@/components/admin-gate";
import { CATEGORY_COLORS } from "../../constants";
import { evidenceHostUrl, evidenceLabel, type EvidenceLinkRepo } from "../../helpers";
import { SnippetBlock } from "../SnippetBlock";
import { s } from "./styles";

export function ConventionCard({
  convention,
  repoId,
  repo,
}: {
  convention: Convention;
  repoId: string | null | undefined;
  /** The active repo — source of the host evidence link (absent → no link). */
  repo?: EvidenceLinkRepo | null;
}) {
  const t = useTranslations("conventions");
  const update = useUpdateConvention(repoId);
  const { isAdmin } = useCan();
  const [editing, setEditing] = React.useState(false);
  const [draftRule, setDraftRule] = React.useState(convention.rule);

  const accepted = convention.status === "accepted";
  const rejected = convention.status === "rejected";
  const pct = Math.round(convention.confidence * 100);
  const barColor = pct >= 85 ? "var(--ok)" : pct >= 65 ? "var(--warn)" : "var(--text-muted)";

  const setStatus = (status: "accepted" | "rejected") => {
    // Clicking the active button toggles back to pending.
    update.mutate({
      id: convention.id,
      patch: { status: convention.status === status ? "pending" : status },
    });
  };

  const saveRule = () => {
    const rule = draftRule.trim();
    if (rule && rule !== convention.rule) {
      update.mutate({ id: convention.id, patch: { rule } });
    }
    setEditing(false);
  };

  return (
    <div style={s.card(accepted, rejected)}>
      <div style={s.main}>
        <div style={s.titleRow}>
          <Badge color={CATEGORY_COLORS[convention.category]}>{convention.category}</Badge>
          {editing && isAdmin ? (
            <div style={s.editRow}>
              <TextInput value={draftRule} onChange={setDraftRule} />
              <Button kind="primary" size="sm" icon="Check" onClick={saveRule}>
                {t("card.save")}
              </Button>
              <Button
                kind="tertiary"
                size="sm"
                onClick={() => {
                  setDraftRule(convention.rule);
                  setEditing(false);
                }}
              >
                {t("card.cancel")}
              </Button>
            </div>
          ) : (
            <>
              <span style={s.title(rejected)}>{convention.rule}</span>
              <IconBtn
                icon="Edit"
                label={t("card.edit")}
                onClick={() => setEditing(true)}
                aria-disabled={!isAdmin}
              />
            </>
          )}
        </div>

        <SnippetBlock
          label={evidenceLabel(convention)}
          snippet={convention.evidence_snippet}
          href={evidenceHostUrl(repo, convention)}
          linkLabel={t("card.viewOn", { provider: hostLabelKey(repo) })}
        />

        <div style={s.confidenceRow}>
          <span style={s.confidenceLabel}>{t("card.confidence")}</span>
          <div style={s.confidenceBar}>
            <ProgressBar value={pct} color={barColor} />
          </div>
          <span className="mono tnum" style={s.confidencePct}>
            {pct}%
          </span>
        </div>
      </div>

      {/* One AdminOnly gate for both buttons: a single visible hint, both
          controls described by it. */}
      <div style={s.actions}>
        <AdminOnly>
          {(gate) => (
            <>
              <Button
                kind={accepted ? "primary" : "secondary"}
                icon="Check"
                active={accepted}
                loading={update.isPending}
                {...gate.controlProps}
                onClick={gate.guard(() => setStatus("accepted"))}
              >
                {accepted ? t("card.accepted") : t("card.accept")}
              </Button>
              <Button
                kind="ghost"
                icon="X"
                active={rejected}
                {...gate.controlProps}
                onClick={gate.guard(() => setStatus("rejected"))}
              >
                {rejected ? t("card.rejected") : t("card.reject")}
              </Button>
            </>
          )}
        </AdminOnly>
      </div>
    </div>
  );
}

export default ConventionCard;
