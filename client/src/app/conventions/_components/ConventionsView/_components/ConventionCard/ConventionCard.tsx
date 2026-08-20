/* ConventionCard — one extracted candidate: category badge + rule title
   (inline-editable), evidence snippet with `path:lines` and a GitHub ↗ link
   to the evidence lines, confidence bar,
   Accept / Reject actions (FindingCard's accept/dismiss idiom: active state on
   the buttons, 0.6-opacity muting for rejected cards). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, IconBtn, ProgressBar, TextInput } from "@devdigest/ui";
import type { Convention, Repo } from "@devdigest/shared";
import { useUpdateConvention } from "@/lib/hooks/conventions";
import { CATEGORY_COLORS } from "../../constants";
import { evidenceGitHubUrl, evidenceLabel } from "../../helpers";
import { SnippetBlock } from "../SnippetBlock";
import { s } from "./styles";

export function ConventionCard({
  convention,
  repoId,
  repo,
}: {
  convention: Convention;
  repoId: string | null | undefined;
  /** The active repo — source of the GitHub evidence link (absent → no link). */
  repo?: Pick<Repo, "full_name" | "default_branch"> | null;
}) {
  const t = useTranslations("conventions");
  const update = useUpdateConvention(repoId);
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
          {editing ? (
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
              <IconBtn icon="Edit" label={t("card.edit")} onClick={() => setEditing(true)} />
            </>
          )}
        </div>

        <SnippetBlock
          label={evidenceLabel(convention)}
          snippet={convention.evidence_snippet}
          href={evidenceGitHubUrl(repo, convention)}
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

      <div style={s.actions}>
        <Button
          kind={accepted ? "primary" : "secondary"}
          icon="Check"
          active={accepted}
          loading={update.isPending}
          onClick={() => setStatus("accepted")}
        >
          {accepted ? t("card.accepted") : t("card.accept")}
        </Button>
        <Button kind="ghost" icon="X" active={rejected} onClick={() => setStatus("rejected")}>
          {rejected ? t("card.rejected") : t("card.reject")}
        </Button>
      </div>
    </div>
  );
}

export default ConventionCard;
