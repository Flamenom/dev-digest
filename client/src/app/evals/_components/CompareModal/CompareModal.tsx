/* CompareModal — screen D of the L06 eval pipeline (`specs/06-eval-pipeline.md`
   §9.1 compare, §9.2 promote).

   Two batches of the SAME agent, side by side: four delta cards, the two
   versions' system-prompt diff, and the promote action. Three invariants this
   file exists to hold:

   - **Never colour alone (AC-44, §14).** Every delta renders a glyph (▲ / ▼ /
     =) plus the magnitude and its unit ("4pt", "$0.0031"); every prompt-diff
     line renders a leading `+` / `−` character. The green/red is redundant.
   - **The prompt diff is untrusted text (§16, A05).** It is user-authored
     prompt content rendered as ESCAPED PLAIN TEXT inside a monospace block.
     No `dangerouslySetInnerHTML`, no markdown-with-HTML — plain React children
     only, which React escapes.
   - **Promoting is append-only (§9.2).** Promoting v7 at v9 creates v10; the
     confirmation says so instead of implying a rollback, and `changed: false`
     reports "already the active configuration" rather than a fake success. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, Modal, SectionLabel } from "@devdigest/ui";
import type { EvalCompare, EvalPromptDiffLine } from "@devdigest/shared";
import { useEvalCompare, usePromoteAgentVersion } from "@/lib/hooks/eval";
import { useToast } from "@/lib/toast";
import {
  costDelta,
  DIFF_PREFIX,
  type DeltaTone,
  errorCode,
  formatCost,
  formatPercent,
  formatRanAt,
  percentDelta,
  versionLabel,
} from "./helpers";
import { s } from "./styles";

export interface CompareModalProps {
  /** `batch_id` of the earlier run (the "from" side of every delta). */
  baseBatchId: string;
  /** `batch_id` of the later run (the "to" side of every delta). */
  headBatchId: string;
  /** Owning agent — the promote target. Both batches belong to it (422 otherwise). */
  agentId: string;
  /**
   * The agent's CURRENT live version, for the §9.2 confirmation arithmetic
   * ("the agent is at v9, so this creates v10"). `EvalCompare` only carries the
   * two batches' versions, which are historical; pass `agent.version` from the
   * drill-down's dashboard query. Falls back to the head batch's version, the
   * best available lower bound, when the caller has not resolved it yet.
   */
  currentVersion?: number | null;
  onClose: () => void;
}

/** 422 codes the compare route can answer with (§9.1) → their `eval.errors` key. */
const COMPARE_ERROR_KEYS: Record<string, string> = {
  same_batch: "errors.sameBatch",
  cross_agent_compare: "errors.crossAgentCompare",
};

export function CompareModal({
  baseBatchId,
  headBatchId,
  agentId,
  currentVersion,
  onClose,
}: CompareModalProps) {
  const t = useTranslations("eval");
  const toast = useToast();
  const compare = useEvalCompare(baseBatchId, headBatchId);
  const promote = usePromoteAgentVersion();
  const [confirming, setConfirming] = React.useState(false);

  const data = compare.data;
  const target = data?.promote_target_version ?? null;
  // Append-only history: promoting always lands ABOVE the live version (§9.2).
  const liveVersion = currentVersion ?? data?.head.agent_version ?? target ?? 0;
  const nextVersion = liveVersion + 1;

  const runPromote = () => {
    if (target == null) return;
    promote.mutate(
      { agentId, version: target },
      {
        onSuccess: (result) => {
          setConfirming(false);
          // `changed: false` means the target already equals the live config —
          // no version was created, so the toast must not claim one was.
          toast.success(
            result.changed
              ? t("compare.promoteToast", {
                  version: result.promoted_from_version,
                  next: result.new_version,
                })
              : t("compare.promoteAlreadyActive", { version: result.promoted_from_version }),
          );
        },
      },
    );
  };

  const closeButton = (
    <Button kind="tertiary" onClick={onClose}>
      {t("compare.close")}
    </Button>
  );

  const footer = confirming ? (
    <div style={s.confirmFooter}>
      <p style={s.confirmCopy}>
        {t("compare.promoteConfirm", {
          version: target ?? 0,
          current: liveVersion,
          next: nextVersion,
        })}
      </p>
      <div style={s.footer}>
        <Button kind="tertiary" onClick={() => setConfirming(false)} disabled={promote.isPending}>
          {t("caseEditor.cancel")}
        </Button>
        <Button kind="primary" icon="GitBranch" loading={promote.isPending} onClick={runPromote}>
          {t("compare.promote", { version: target ?? 0 })}
        </Button>
      </div>
    </div>
  ) : (
    <div style={s.footer}>
      {closeButton}
      {target != null && (
        <Button kind="primary" icon="GitBranch" onClick={() => setConfirming(true)}>
          {t("compare.promote", { version: target })}
        </Button>
      )}
    </div>
  );

  const subtitle = data
    ? t("compare.subtitle", {
        baseVersion: versionLabel(data.base.agent_version),
        baseRanAt: formatRanAt(data.base.ran_at),
        headVersion: versionLabel(data.head.agent_version),
        headRanAt: formatRanAt(data.head.ran_at),
      })
    : undefined;

  return (
    <Modal
      width={840}
      title={t("compare.title")}
      subtitle={subtitle}
      onClose={onClose}
      footer={data ? footer : <div style={s.footer}>{closeButton}</div>}
    >
      <div style={s.body}>
        <CompareBody compare={compare} />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ body -- */

/** The four load states, as early returns rather than nested ternaries. */
function CompareBody({
  compare,
}: {
  compare: { data?: EvalCompare; isLoading: boolean; isError: boolean; error?: unknown };
}) {
  const t = useTranslations("eval");

  if (compare.isLoading) return <p style={s.note}>{t("dashboard.loading")}</p>;

  if (compare.isError || !compare.data) {
    // 4xx stays silent globally (client/CLAUDE.md) — the 422s are inline copy.
    const key = COMPARE_ERROR_KEYS[errorCode(compare.error) ?? ""];
    return <p style={s.note}>{key ? t(key) : t("compare.selectTwo")}</p>;
  }

  const data = compare.data;
  // The COST card is omitted entirely when either side is null — a cost delta
  // against an unknown is not a number (§9.1).
  const showCost = data.base.cost_usd != null && data.head.cost_usd != null;

  return (
    <>
      {/* Placed ABOVE the deltas: the reader must learn the numbers are not
          like-for-like before reading them (AC-33). */}
      {!data.comparable && (
        <div style={s.warn} role="alert">
          <Icon.AlertTriangle size={15} style={{ flexShrink: 0, color: "var(--warn)" }} />
          <div style={s.warnBody}>
            <span>{t("compare.notComparable")}</span>
            <span style={s.warnCount}>
              {t("compare.changedCases", { count: data.changed_case_ids.length })}
            </span>
            {data.changed_case_ids.length > 0 && (
              <ul style={s.changedCaseIds}>
                {data.changed_case_ids.map((id) => (
                  <li key={id} className="mono" style={s.changedCaseId}>
                    {id}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div style={s.cards}>
        <DeltaCard
          label={t("compare.delta.recall")}
          from={formatPercent(data.base.recall)}
          to={formatPercent(data.head.recall)}
          delta={percentDelta(data.deltas.recall)}
          higherIsBetter
        />
        <DeltaCard
          label={t("compare.delta.precision")}
          from={formatPercent(data.base.precision)}
          to={formatPercent(data.head.precision)}
          delta={percentDelta(data.deltas.precision)}
          higherIsBetter
        />
        <DeltaCard
          label={t("compare.delta.citation")}
          from={formatPercent(data.base.citation_accuracy)}
          to={formatPercent(data.head.citation_accuracy)}
          delta={percentDelta(data.deltas.citation_accuracy)}
          higherIsBetter
        />
        {showCost && (
          <DeltaCard
            label={t("compare.delta.cost")}
            from={formatCost(data.base.cost_usd)}
            to={formatCost(data.head.cost_usd)}
            delta={costDelta(data.deltas.cost_usd)}
            higherIsBetter={false}
          />
        )}
      </div>

      <section>
        <SectionLabel icon="FileText">{t("compare.promptDiff")}</SectionLabel>
        <PromptDiff available={data.prompt_diff_available} lines={data.prompt_diff} />
      </section>
    </>
  );
}

/* ------------------------------------------------------------ delta card -- */

function DeltaCard({
  label,
  from,
  to,
  delta,
  higherIsBetter,
}: {
  label: string;
  from: string;
  to: string;
  delta: { text: string; tone: DeltaTone };
  /** Recall/precision/citation are better when up; cost is better when down. */
  higherIsBetter: boolean;
}) {
  return (
    <div style={s.card}>
      <div style={s.cardLabel}>{label}</div>
      {/* One text node so a screen reader reads "78% → 82%" as one value. */}
      <div className="tnum" style={s.cardValues}>{`${from} → ${to}`}</div>
      <div className="tnum" style={s.cardDelta(delta.tone, higherIsBetter)}>
        {delta.text}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- prompt diff -- */

function PromptDiff({
  available,
  lines,
}: {
  available: boolean;
  lines: EvalPromptDiffLine[];
}) {
  const t = useTranslations("eval");

  // A pre-0018 batch (null `agent_version`) or a missing snapshot: say so
  // rather than render a fake diff (§9.1).
  if (!available) return <p style={s.note}>{t("compare.promptDiffUnavailable")}</p>;

  return (
    <>
      <div style={s.legend}>
        <span style={s.legendOld}>{t("compare.legendOld")}</span>
        <span style={s.legendNew}>{t("compare.legendNew")}</span>
      </div>
      {/* Plain React children only — the prompt is user-authored text and React
          escapes it. Never `dangerouslySetInnerHTML` here (§16). */}
      <pre style={s.diffBlock} role="group" aria-label={t("compare.promptDiff")}>
        {lines.map((line, i) => (
          <div key={`${i}-${line.kind}`} style={s.diffLine(line.kind)}>
            {`${DIFF_PREFIX[line.kind]}${line.text}`}
          </div>
        ))}
      </pre>
    </>
  );
}

export default CompareModal;
