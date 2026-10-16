/* AgentEditor — agent config editor (model + system prompt) + the L02 Skills
   tab (link/order the agent's skills), the L05 Context tab and the L06 Evals
   tab. Later lessons add Stats/CI. Tab state lives in ?tab=. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Tabs } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { ConfigTab } from "./_components/ConfigTab";
import { ContextTab } from "./_components/ContextTab";
import { EvalsTab } from "./_components/EvalsTab";
import { SkillsTab } from "./_components/SkillsTab";
import { TABS } from "./constants";
import { s } from "./styles";

/** Tab key → the component that renders it. A COMPONENT MAP, deliberately not a
    `renderTab()` factory: `<Body />` keeps a stable component identity per key,
    so React reconciles (and remounts on a real tab change) instead of throwing
    the subtree away on every parent render. */
const TAB_VIEWS: Record<string, React.ComponentType<{ agent: Agent }>> = {
  config: ConfigTab,
  skills: SkillsTab,
  context: ContextTab,
  evals: EvalsTab,
};

const FALLBACK_TAB = "config";

export function AgentEditor({ agent, tab, onTab }: { agent: Agent; tab: string; onTab: (t: string) => void }) {
  const t = useTranslations("agents");
  const tabs = TABS.map((tb) => ({ key: tb.key, label: t(tb.labelKey), icon: tb.icon }));
  // An unknown `?tab=` value renders Config, matching page.tsx's VALID_TABS guard.
  const Body = TAB_VIEWS[tab] ?? TAB_VIEWS[FALLBACK_TAB]!;
  return (
    <div style={s.wrap}>
      <div style={s.tabsBar}>
        <Tabs tabs={tabs} value={tab} onChange={onTab} pad="0 24px" />
      </div>
      <div style={s.body}>
        <Body agent={agent} />
      </div>
    </div>
  );
}
