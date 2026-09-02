/* AgentSwitcher — hop between the agents that have eval cases without going
   back to `/evals` first (design C's header control).

   Switching preserves the current `?days=` window: the window is a property of
   what the user is looking at, not of the agent. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { SelectInput } from "@devdigest/ui";
import { s } from "./styles";

export interface AgentSwitcherOption {
  id: string;
  name: string;
}

export interface AgentSwitcherProps {
  agentId: string;
  agents: readonly AgentSwitcherOption[];
  onSelect: (agentId: string) => void;
}

export function AgentSwitcher({ agentId, agents, onSelect }: AgentSwitcherProps) {
  const t = useTranslations("eval");

  // The switcher is meaningless with a single destination, and the current
  // agent may be missing from the overview (it has no cases yet) — in both
  // cases the header still shows the agent's name, which the parent renders.
  if (agents.length < 2) return null;

  return (
    // Wrapping <label> associates the text with the <select> implicitly:
    // SelectInput takes no `id`, so `htmlFor` would dangle.
    <label style={s.wrap}>
      <span style={s.srOnly}>{t("dashboard.agentsHeading")}</span>
      <span style={s.select}>
        <SelectInput
          value={agentId}
          mono={false}
          onChange={onSelect}
          options={agents.map((a) => ({ value: a.id, label: a.name }))}
        />
      </span>
    </label>
  );
}

export default AgentSwitcher;
