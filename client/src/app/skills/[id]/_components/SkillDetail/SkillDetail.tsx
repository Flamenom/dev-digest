/* SkillDetail — the master-detail right pane (§4.4): header (sparkle icon +
   mono name + type badge + v{n} chip) over Config | Preview | Stats | Versions
   tabs. NO Evals tab, NO "Run on evals" button (spec decision 7). Tab state
   lives in ?tab= (owned by the page). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, Tabs } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { TYPE_COLORS } from "../../../_components/constants";
import { ConfigTab } from "./_components/ConfigTab";
import { PreviewTab } from "./_components/PreviewTab";
import { StatsTab } from "./_components/StatsTab";
import { VersionsTab } from "./_components/VersionsTab";
import { TABS } from "./constants";
import { s } from "./styles";

export function SkillDetail({
  skill,
  tab,
  onTab,
}: {
  skill: Skill;
  tab: string;
  onTab: (t: string) => void;
}) {
  const t = useTranslations("skills");
  const tabs = TABS.map((tb) => ({ key: tb.key, label: t(tb.labelKey), icon: tb.icon }));

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div style={s.iconBox}>
          <Icon.Sparkles size={16} />
        </div>
        <h1 className="mono" style={s.name}>
          {skill.name}
        </h1>
        <Badge color={TYPE_COLORS[skill.type]}>{t(`listItem.type.${skill.type}`)}</Badge>
        <Badge mono color="var(--text-secondary)">
          {t("preview.version", { version: skill.version })}
        </Badge>
      </div>
      <div style={s.tabsBar}>
        <Tabs tabs={tabs} value={tab} onChange={onTab} pad="0 24px" />
      </div>
      <div style={s.body}>
        {tab === "config" && <ConfigTab skill={skill} />}
        {tab === "preview" && <PreviewTab skill={skill} />}
        {tab === "stats" && <StatsTab skill={skill} />}
        {tab === "versions" && <VersionsTab skill={skill} />}
      </div>
    </div>
  );
}
