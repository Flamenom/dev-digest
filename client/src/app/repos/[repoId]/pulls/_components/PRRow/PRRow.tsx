/* PRRow — one clickable row in the PR list table. Ported from screen_dashboard.jsx. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon, Avatar, Badge, CircularScore } from "@devdigest/ui";
import type { PrMeta } from "@/lib/types";
import { usePrReviews } from "@/lib/hooks/reviews";
import {
  FindingsHoverCard,
  FindingsSeverityChips,
  totalCount,
  type SeverityCounts,
} from "@/components/FindingsHoverCard";
import { RunCostBadge } from "../RunCostBadge";
import { SIZE_COLOR, STATUS_META } from "../../constants";
import { relativeTime, sizeOf } from "../../helpers";
import { s } from "../../styles";

export function PRRow({ pr, repoId }: { pr: PrMeta; repoId: string }) {
  const t = useTranslations("prReview");
  const router = useRouter();
  const [h, setH] = React.useState(false);
  const st = STATUS_META[pr.status] ?? STATUS_META.needs_review!;
  const { size, lines } = sizeOf(pr);
  const reviewed = pr.score != null; // null score ⇒ PR has never been reviewed
  return (
    <div
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      onClick={() => router.push(`/repos/${repoId}/pulls/${pr.number}`)}
      style={s.row(h)}
    >
      <div style={s.rowTitleCell}>
        <Icon.GitPullRequest size={15} style={s.rowIcon(st.c)} />
        <div style={s.rowTitleWrap}>
          <div style={s.rowTitle(h)}>{pr.title}</div>
          <span className="mono" style={s.rowNumber}>
            #{pr.number}
          </span>
        </div>
      </div>
      <div style={s.authorCell}>
        <Avatar name={pr.author} size={18} />
        {pr.author}
      </div>
      <div>
        <Badge
          color={SIZE_COLOR[size]}
          bg="transparent"
          style={s.sizeBadgeBorder(SIZE_COLOR[size]!)}
        >
          {size} · {lines}
        </Badge>
      </div>
      <div style={s.scoreCell}>
        {reviewed ? (
          <CircularScore score={pr.score!} size={34} stroke={3} />
        ) : (
          <span style={s.muted}>—</span>
        )}
      </div>
      <div style={s.findingsCell} onClick={(e) => e.stopPropagation()}>
        <PrFindingsCell prId={pr.id} counts={pr.findings ?? null} />
      </div>
      <div>
        <Badge dot color={st.c} bg="transparent">
          {t(`list.status.${st.labelKey}`)}
        </Badge>
      </div>
      <div>
        <RunCostBadge usd={pr.cost_usd} variant="compact" />
      </div>
      <div style={s.updatedCell}>{relativeTime(pr.updated_at)}</div>
    </div>
  );
}

/**
 * FINDINGS cell: severity chips for the latest review. Findings counts come from
 * the list payload (`pr.findings`); the hover card lazily fetches the full
 * findings via the existing reviews endpoint only once the pointer enters.
 */
function PrFindingsCell({
  prId,
  counts,
}: {
  prId: string | null | undefined;
  counts: SeverityCounts | null;
}) {
  const t = useTranslations("prReview");
  const [hover, setHover] = React.useState(false);
  const reviews = usePrReviews(hover ? prId : null);

  // Aggregate findings across every agent's LATEST review — mirrors the server's
  // list rollup, so the hover card matches the summed chip counts (not one
  // arbitrary agent's review).
  const findings = React.useMemo(() => {
    const revs = (reviews.data ?? []).filter((r) => r.kind === "review");
    const latestPerAgent = new Map<string, (typeof revs)[number]>();
    for (const rev of revs) {
      const key = rev.agent_id ?? rev.id;
      const cur = latestPerAgent.get(key);
      // ISO timestamps compare lexicographically → newest wins.
      if (!cur || rev.created_at > cur.created_at) latestPerAgent.set(key, rev);
    }
    return [...latestPerAgent.values()].flatMap((r) => r.findings);
  }, [reviews.data]);

  if (counts == null) return <span style={s.muted}>—</span>;

  const total = totalCount(counts);
  const chips = <FindingsSeverityChips counts={counts} />;
  if (total === 0) return chips;

  return (
    <FindingsHoverCard
      findings={findings}
      loading={reviews.isLoading}
      heading={t("findings.heading", { count: total })}
      onHoverStart={() => setHover(true)}
    >
      {chips}
    </FindingsHoverCard>
  );
}
