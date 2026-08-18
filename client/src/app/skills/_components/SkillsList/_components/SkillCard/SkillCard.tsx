/* SkillCard — list-column card per the L02 design: sparkle icon, mono name,
   global enabled Toggle (optimistic PUT via the parent), truncated description,
   type + source badges, `needs vetting` chip for non-manual disabled skills and
   an `N agents` footer stat from /skills/usage. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, Badge, Toggle } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { SOURCE_ICONS, TYPE_COLORS } from "../../../constants";
import { s } from "./styles";

export function SkillCard({
  skill,
  active,
  agentCount,
  onClick,
  onToggle,
}: {
  skill: Skill;
  active?: boolean;
  agentCount: number;
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const t = useTranslations("skills");
  const needsVetting = skill.source !== "manual" && !skill.enabled;

  return (
    <div onClick={onClick} style={s.card(!!active, skill.enabled)}>
      <div style={s.headerRow}>
        <div style={s.iconBox}>
          <Icon.Sparkles size={14} />
        </div>
        <span className="mono" style={s.name}>
          {skill.name}
        </span>
        {onToggle && (
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle on={skill.enabled} onChange={onToggle} size={14} />
          </div>
        )}
      </div>
      <div style={s.description}>{skill.description}</div>
      <div style={s.metaRow}>
        <Badge color={TYPE_COLORS[skill.type]}>{t(`listItem.type.${skill.type}`)}</Badge>
        <Badge color="var(--text-secondary)" icon={SOURCE_ICONS[skill.source]}>
          {t(`listItem.source.${skill.source}`)}
        </Badge>
        {needsVetting && (
          <span title={t("listItem.vettingTitle")}>
            <Badge color="var(--warn)" bg="var(--warn-bg)">
              {t("listItem.needsVetting")}
            </Badge>
          </span>
        )}
      </div>
      <div style={s.footer}>
        <Icon.Cpu size={12} />
        <span className="tnum">{t("listItem.agentsCount", { count: agentCount })}</span>
      </div>
    </div>
  );
}
