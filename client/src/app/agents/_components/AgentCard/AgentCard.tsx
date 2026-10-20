/* AgentCard — model chip, skills count, enabled toggle. Stats are an A5 mount;
   we render the provider/model + skill count here.

   Multi-user (AC-33): the enabled toggle is an agent edit (PUT /agents/:id),
   Admin-only — a Member sees it aria-disabled (focusable, announced disabled,
   clicks ignored). The delete is destructive, so it stays hidden for a Member.
   Local mode = Admin. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, Badge, Toggle } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { useDeleteAgent } from "@/lib/hooks/agents";
import { useCan } from "@/lib/hooks/permissions";
import { HiddenForMember } from "@/components/admin-gate";
import { modelColor } from "./helpers";
import { s } from "./styles";

export function AgentCard({
  ag,
  active,
  skillCount,
  onClick,
  onToggle,
}: {
  ag: Agent;
  active?: boolean;
  skillCount?: number;
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const t = useTranslations("agents");
  const del = useDeleteAgent();
  const { isAdmin } = useCan();
  const color = modelColor(ag.model);
  return (
    <div onClick={onClick} style={s.card(!!active, ag.enabled)}>
      <div style={s.headerRow}>
        <div style={s.iconBox}>
          <Icon.Cpu size={15} />
        </div>
        <span style={s.name}>{ag.name}</span>
        {onToggle && (
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle
              on={ag.enabled}
              onChange={onToggle}
              size={14}
              label={t("card.toggleLabel", { name: ag.name })}
              aria-disabled={!isAdmin}
            />
          </div>
        )}
        <HiddenForMember>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Delete agent "${ag.name}"? This cannot be undone.`)) del.mutate(ag.id);
            }}
            disabled={del.isPending}
            title="Delete agent"
            aria-label="Delete agent"
            style={{
              background: "none",
              border: "none",
              cursor: del.isPending ? "not-allowed" : "pointer",
              color: "var(--text-muted)",
              display: "inline-flex",
              padding: 4,
            }}
          >
            <Icon.Trash size={14} style={del.isPending ? { animation: "ddspin 1s linear infinite" } : undefined} />
          </button>
        </HiddenForMember>
      </div>
      <div style={s.description}>{ag.description || t("card.noDescription")}</div>
      <div style={s.metaRow}>
        <span className="mono" style={s.modelChip(color)}>
          {ag.model}
        </span>
        {skillCount != null && (
          <Badge color="var(--text-secondary)" icon="Sparkles">
            {t("card.skillCount", { count: skillCount })}
          </Badge>
        )}
      </div>
    </div>
  );
}
