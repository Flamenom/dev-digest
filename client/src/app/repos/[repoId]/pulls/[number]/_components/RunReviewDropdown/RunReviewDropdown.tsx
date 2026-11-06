/* RunReviewDropdown — ported from components2.jsx.
   "Run all enabled agents" / a specific agent → kicks off POST /pulls/:id/review
   and hands the resulting runIds up so the parent can stream SSE live status. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Dropdown, type DropdownItemDef } from "@devdigest/ui";
import { useAgents } from "@/lib/hooks/agents";
import { useCan } from "@/lib/hooks/permissions";
import { useRunReview } from "@/lib/hooks/reviews";
import { useToast } from "@/lib/toast";
import { CREATE_AGENT_HREF, DROPDOWN_WIDTH } from "./constants";
import { agentMenuItems, isNoEnabledAgentsError, runAllItem, zeroStateItem } from "./helpers";

export function RunReviewDropdown({
  prId,
  size = "sm",
  kind = "primary",
  warnMerged = false,
  onRunStart,
  onRunsStarted,
  onRunSettled,
}: {
  prId: string;
  size?: "sm" | "md" | "lg";
  kind?: "primary" | "secondary";
  /** PR is already merged/closed — dim the trigger and warn, but still allow. */
  warnMerged?: boolean;
  /** Fired the moment a run is kicked off (before it completes). */
  onRunStart?: () => void;
  onRunsStarted?: (runIds: string[]) => void;
  /** Fired when the run request settles (success or error). */
  onRunSettled?: () => void;
}) {
  const t = useTranslations("prReview");
  const router = useRouter();
  const { data: agents } = useAgents();
  const { isAdmin, isPending: sessionPending } = useCan();
  const toast = useToast();
  const run = useRunReview();
  const loaded = agents !== undefined;
  const all = agents ?? [];
  const hasEnabled = all.some((a) => a.enabled);

  const kick = async (opts: { all?: boolean; agentId?: string }) => {
    onRunStart?.();
    try {
      const res = await run.mutateAsync({ prId, ...opts });
      onRunsStarted?.(res.runs.map((r) => r.run_id));
    } catch (err) {
      // The dropdown already blocks "Run all" with no enabled agent; this covers
      // a stale list (agent disabled elsewhere) the server rejects with 409.
      if (isNoEnabledAgentsError(err)) toast.error(t("runReview.noEnabledAgentsError"));
      else throw err;
    } finally {
      onRunSettled?.();
    }
  };

  // While the agents list or the session probe is in flight, render no
  // zero-state entry (no flash of the wrong/role-less hint). "Run all" still
  // targets only enabled agents.
  const agentItems = agentMenuItems(
    all,
    (agentId) => kick({ agentId }),
    zeroStateItem({
      pending: !loaded || sessionPending,
      isAdmin,
      adminLabel: t("runReview.noAgentsAdmin"),
      memberLabel: t("runReview.noAgentsMember"),
      onCreate: () => router.push(CREATE_AGENT_HREF),
    }),
  );

  const items: DropdownItemDef[] = [
    // Merged/closed PRs can still be reviewed (informational only); lead with a
    // muted, non-actionable warning so the intent is clear.
    ...(warnMerged
      ? [
          { label: t("runReview.mergedWarning"), icon: "AlertTriangle" as const, muted: true },
          { divider: true } as DropdownItemDef,
        ]
      : []),
    runAllItem({
      hasEnabled,
      loaded,
      label: t("runReview.runAll"),
      disabledReason: t("runReview.noEnabledAgents"),
      onRun: () => kick({ all: true }),
    }),
    { divider: true },
    ...(agentItems.length ? [...agentItems, { divider: true }] : []),
    { label: t("runReview.configureAgents"), icon: "Settings", muted: true, onClick: () => router.push("/agents") },
  ];

  return (
    <Dropdown
      width={DROPDOWN_WIDTH}
      align="right"
      items={items}
      trigger={
        <span
          title={warnMerged ? t("runReview.mergedTooltip") : undefined}
          style={warnMerged ? { opacity: 0.6 } : undefined}
        >
          <Button kind={kind} size={size} iconRight="ChevronDown" icon="Sparkles" loading={run.isPending}>
            {run.isPending ? t("runReview.running") : t("runReview.runReview")}
          </Button>
        </span>
      }
    />
  );
}
