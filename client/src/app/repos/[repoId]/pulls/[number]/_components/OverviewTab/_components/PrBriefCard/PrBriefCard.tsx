/* PrBriefCard — the PR Brief at the top of the Overview tab
   (spec `specs/2026-08-27-pr-brief.md`).

   Two halves with very different trust levels:
     - the HEADER is fully deterministic (status, score gauge + risk band,
       findings/blockers, cost, tokens) and therefore renders even when the
       generation failed (NFR-7, AC-36);
     - the BODY is model-authored prose, always rendered as TEXT NODES — never
       `dangerouslySetInnerHTML` (NFR-6) — with a per-`generation.state`
       message standing in for it when there is nothing to show.

   Numbers come from the payload only: the risk bands are NOT re-derived here
   (`CircularScore`'s thresholds are inline/unexported and the vendored design
   system must not be forked), and regeneration happens on explicit user action
   only (AC-6, N5). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, CircularScore, Icon, SectionLabel, Skeleton } from "@devdigest/ui";
import type {
  BriefMissingInput,
  BriefStatus,
  FindingRecord,
  PrBriefDetail,
  RiskSeverity,
} from "@devdigest/shared";
import { FindingsHoverCard } from "@/components/FindingsHoverCard";
import { formatTokensAbbrev } from "@/lib/format";
import { useRegenerateBrief } from "@/lib/hooks/brief";
import { usePrReviews } from "@/lib/hooks/reviews";
import { RunCostBadge } from "../../../../../_components/RunCostBadge";
import { VERDICT_META } from "../../../VerdictBanner/constants";
import { GAUGE_SIZE, GAUGE_STROKE, RISK_LEVEL_COLOR, SKELETON_HEIGHT, STATUS_ICON_SIZE } from "./constants";
import { latestPerAgentFindings, statusMeta } from "./helpers";
import { s } from "./styles";

interface PrBriefCardProps {
  /** PR row uuid — every brief API is keyed by uuid, never the route number. */
  prId: string | null;
  /** The brief payload; the Overview tab owns the `usePrBrief` query. */
  brief: PrBriefDetail | null | undefined;
  isLoading?: boolean;
  /** Optional "run a review" affordance for the `not_reviewed` state (AC-18). */
  onRunReview?: () => void;
}

export function PrBriefCard({ prId, brief, isLoading = false, onRunReview }: PrBriefCardProps) {
  const t = useTranslations("brief");
  const regenerate = useRegenerateBrief(prId);
  // Findings behind the header badge (AC-20); the counts themselves stay
  // deterministic and come from the brief payload.
  const reviews = usePrReviews(prId);
  const findings = latestPerAgentFindings(reviews.data);
  const busy = regenerate.isPending;

  if (isLoading) {
    return (
      <section>
        <SectionLabel icon="FileText">{t("card.title")}</SectionLabel>
        <Skeleton height={SKELETON_HEIGHT} />
      </section>
    );
  }

  // 4xx stays silent (client/CLAUDE.md) → inline empty state, never a toast.
  if (!brief) {
    return (
      <section>
        <SectionLabel icon="FileText">{t("card.title")}</SectionLabel>
        <div style={s.empty}>
          <p style={s.emptyText}>{t("unavailable")}</p>
          <p style={s.emptyHint}>{t("unavailableHint")}</p>
        </div>
      </section>
    );
  }

  const meta = statusMeta(brief.status);
  const StatusIcon = Icon[meta.icon];

  return (
    <section>
      <SectionLabel icon="FileText">{t("card.title")}</SectionLabel>
      <div style={s.card}>
        <div style={s.iconBox(meta.bg, meta.c)}>
          <StatusIcon size={STATUS_ICON_SIZE} />
        </div>

        <div style={s.main}>
          <div style={s.titleRow}>
            <StatusLabel status={brief.status} color={meta.c} onRunReview={onRunReview} />
            <FindingsBadge
              findings={findings}
              count={brief.findings_count}
              blockers={brief.blockers}
              loading={reviews.isLoading}
            />
            {brief.stale && (
              <Badge icon="Clock" color="var(--warn)">
                {t("card.staleBadge")}
              </Badge>
            )}
          </div>

          <BriefBody brief={brief} />
          {brief.stale && (
            <p style={s.staleReason}>{brief.stale_reason ?? t("card.staleReason")}</p>
          )}
          <MissingInputs items={brief.missing_inputs} />
        </div>

        <div style={s.rightCol}>
          <Button
            kind="ghost"
            size="sm"
            icon="RefreshCw"
            loading={busy}
            aria-busy={busy}
            aria-label={busy ? t("card.regenerating") : t("card.regenerate")}
            onClick={() => {
              // AC-7: a second activation while busy must not bill a second call.
              if (!busy) regenerate.mutate();
            }}
          />
          {/* AC-18a: no score ⇒ no gauge and no risk-level label at all. */}
          {brief.score != null && <ScoreGauge score={brief.score} riskLevel={brief.risk_level} />}
          <CostRow
            costUsd={brief.cost_usd}
            tokensIn={brief.tokens_in}
            tokensOut={brief.tokens_out}
          />
        </div>
      </div>
    </section>
  );
}

/** Verdict label, or the `not_reviewed` state plus its review CTA (AC-18). */
function StatusLabel({
  status,
  color,
  onRunReview,
}: {
  status: BriefStatus;
  color: string;
  onRunReview?: () => void;
}) {
  const t = useTranslations("brief");
  const tr = useTranslations("prReview");
  if (status !== "not_reviewed") {
    return <span style={s.label(color)}>{tr(`verdict.${VERDICT_META[status].labelKey}`)}</span>;
  }
  return (
    <>
      <span style={s.label(color)}>{t("card.notReviewed")}</span>
      {onRunReview ? (
        <Button kind="primary" size="sm" icon="Sparkles" onClick={onRunReview}>
          {t("card.reviewCta")}
        </Button>
      ) : (
        <span style={s.cta}>{t("card.reviewCta")}</span>
      )}
    </>
  );
}

/** Deterministic counts; the panel behind them lists every counted finding (AC-20). */
function FindingsBadge({
  findings,
  count,
  blockers,
  loading,
}: {
  findings: FindingRecord[];
  count: number;
  blockers: number;
  loading: boolean;
}) {
  const t = useTranslations("brief");
  const tr = useTranslations("prReview");
  // `verdict.blockers` is an APPENDED fragment (" · {count} blockers"), exactly
  // as VerdictBanner concatenates it.
  const label = `${tr("verdict.findingsCount", { count })}${
    blockers > 0 ? tr("verdict.blockers", { count: blockers }) : ""
  }`;
  const badge = <Badge color="var(--text-secondary)">{label}</Badge>;
  if (count === 0) return badge;
  return (
    <FindingsHoverCard
      findings={findings}
      loading={loading}
      heading={t("card.findingsPanel.title")}
      triggerLabel={label}
      groupBySeverity
      maxRows={Infinity}
    >
      {badge}
    </FindingsHoverCard>
  );
}

/** Model prose, or the generation-state message that stands in for it. */
function BriefBody({ brief }: { brief: PrBriefDetail }) {
  const t = useTranslations("brief");
  const { state, reason } = brief.generation;

  if (state !== "ok") {
    const title =
      state === "failed"
        ? t("card.generationFailed")
        : state === "unavailable"
          ? t("card.unavailableNoFiles")
          : t("card.notGenerated");
    // `card.generationFailed` does not interpolate — the server reason is its
    // own text node (and it is data, never markup).
    const hint = state === "not_generated" ? t("card.notGeneratedHint") : reason;
    return (
      <div style={s.note}>
        <p style={s.noteTitle}>{title}</p>
        {hint && <p style={s.noteReason}>{hint}</p>}
      </div>
    );
  }

  return (
    <>
      {brief.what && <p style={s.prose}>{brief.what}</p>}
      {brief.why && <p style={s.proseWhy}>{brief.why}</p>}
    </>
  );
}

/** Inputs the generation could not consult, stated honestly (AC-32 – AC-34). */
function MissingInputs({ items }: { items: BriefMissingInput[] }) {
  const t = useTranslations("brief");
  if (items.length === 0) return null;
  return (
    <div style={s.missing}>
      <span style={s.missingTitle}>
        <Icon.EyeOff size={12} />
        {t("card.missingInputs")}
      </span>
      <ul style={s.missingList}>
        {items.map((mi, i) => (
          <li key={`${mi.input}:${i}`} style={s.missingItem}>
            <span style={s.missingInput}>{mi.input}</span> — {mi.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The deterministic score gauge; `risk_level` is its band, named in words (AC-40). */
function ScoreGauge({ score, riskLevel }: { score: number; riskLevel: RiskSeverity | null }) {
  const t = useTranslations("brief");
  const tr = useTranslations("prReview");
  return (
    <div style={s.scoreCol}>
      <CircularScore score={score} size={GAUGE_SIZE} stroke={GAUGE_STROKE} />
      <span style={s.scoreLabel}>{tr("verdict.prScore")}</span>
      {riskLevel && (
        <span style={s.riskLevel(RISK_LEVEL_COLOR[riskLevel])}>{t(`card.riskLevel.${riskLevel}`)}</span>
      )}
    </div>
  );
}

/** Total PR spend: cost (em dash when null, AC-19) + tokens in → out (AC-42). */
function CostRow({
  costUsd,
  tokensIn,
  tokensOut,
}: {
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}) {
  const t = useTranslations("brief");
  return (
    <div style={s.costRow} aria-label={t("card.costTotal")} title={t("card.costTotalHint")}>
      <Icon.DollarSign size={12} style={s.costIcon} />
      <RunCostBadge usd={costUsd} variant="compact" />
      <span className="mono" style={s.tokens}>
        {t("card.tokensInOut", {
          tokensIn: formatTokensAbbrev(tokensIn),
          tokensOut: formatTokensAbbrev(tokensOut),
        })}
      </span>
    </div>
  );
}

export default PrBriefCard;
