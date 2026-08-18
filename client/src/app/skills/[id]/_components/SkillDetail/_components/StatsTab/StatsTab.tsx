/* StatsTab — minimal-honest (spec decision 8): only data derivable today.
   Stat card "Used by: N agents" + the list of those agents with Open links.
   Pull frequency / accept rate / findings-by-category need per-run skill
   attribution that doesn't exist yet — rendered as disabled placeholders. */
"use client";

import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Icon } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { useSkillsUsage } from "@/lib/hooks/skills";
import { s } from "./styles";

const PLACEHOLDERS = ["pullFrequency", "acceptRate", "findingsByCategory"] as const;

export function StatsTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  const { data: usage } = useSkillsUsage();
  const agents = usage?.find((u) => u.skill_id === skill.id)?.agents ?? [];

  return (
    <div style={s.wrap}>
      <div style={s.statRow}>
        <Card>
          <div style={s.statLabel}>{t("stats.usedByLabel")}</div>
          <div className="tnum" style={s.statValue}>
            {t("stats.usedByValue", { count: agents.length })}
          </div>
        </Card>
        {PLACEHOLDERS.map((key) => (
          <Card key={key} style={s.placeholderCard}>
            <div style={s.statLabel}>{t(`stats.placeholder.${key}`)}</div>
            <div style={s.placeholderValue}>{t("stats.placeholder.comingSoon")}</div>
          </Card>
        ))}
      </div>
      <Card pad={false}>
        <div style={s.panelTitle}>{t("stats.panelTitle")}</div>
        {agents.length === 0 ? (
          <div style={s.noAgents}>{t("stats.noAgents")}</div>
        ) : (
          agents.map((agent) => (
            <div key={agent.id} style={s.agentRow}>
              <Icon.Cpu size={14} style={s.agentIcon} />
              <span style={s.agentName}>{agent.name}</span>
              <Link href={`/agents/${agent.id}`} style={s.openLink}>
                {t("stats.open")}
                <Icon.ExternalLink size={12} />
              </Link>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
