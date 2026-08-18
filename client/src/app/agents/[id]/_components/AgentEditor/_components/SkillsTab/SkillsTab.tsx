"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Checkbox, Chip, EmptyState, ErrorState, Skeleton, TextInput } from "@devdigest/ui";
import type { Agent, Skill } from "@devdigest/shared";
import { useAgentSkills, useSetAgentSkills, useWorkspaceSkills } from "@/lib/hooks/agents";
import { linkedIdsOf, matchesFilter, moveTo, orderRows, toggleLinked } from "./helpers";
import { s } from "./styles";

const DRAG_HANDLE_GLYPH = "≡";

/** Skills tab — link/unlink and order the agent's skills (membership model).
    Every change posts the FULL ordered set to POST /agents/:id/skills. */
export function SkillsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents");
  const skillsQ = useWorkspaceSkills();
  const linksQ = useAgentSkills(agent.id);
  const setSkills = useSetAgentSkills(agent.id);

  const [filter, setFilter] = React.useState("");
  // Drag state: id being dragged + the live preview of the linked-id order.
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dragOrder, setDragOrder] = React.useState<string[] | null>(null);

  const skills = skillsQ.data ?? [];
  const linkedIds = React.useMemo(() => linkedIdsOf(linksQ.data ?? []), [linksQ.data]);
  const displayIds = dragOrder ?? linkedIds;
  const rows = orderRows(skills, displayIds);
  const filtering = filter.trim().length > 0;
  const visible = filtering ? rows.filter((sk) => matchesFilter(sk, filter)) : rows;

  const toggle = (skillId: string, on: boolean) => {
    if (setSkills.isPending) return;
    setSkills.mutate(toggleLinked(linkedIds, skillId, on));
  };

  const startDrag = (e: React.DragEvent, skillId: string) => {
    // dataTransfer is absent in jsdom — guard every access.
    e.dataTransfer?.setData?.("text/plain", skillId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    setDragId(skillId);
    setDragOrder(linkedIds);
  };

  const dragOverRow = (e: React.DragEvent, overId: string) => {
    if (!dragId || !displayIds.includes(overId)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragOrder((cur) => moveTo(cur ?? linkedIds, dragId, overId));
  };

  // Commit on dragend (fires after drop and on cancel): post the order the user sees.
  const endDrag = () => {
    if (dragId && dragOrder && dragOrder.join("\n") !== linkedIds.join("\n")) {
      setSkills.mutate(dragOrder);
    }
    setDragId(null);
    setDragOrder(null);
  };

  if (skillsQ.isError || linksQ.isError) {
    return (
      <ErrorState
        title={t("skills.title")}
        body={t("skills.loadError")}
        onRetry={() => {
          void skillsQ.refetch();
          void linksQ.refetch();
        }}
      />
    );
  }

  if (skillsQ.isLoading || linksQ.isLoading) {
    return (
      <div style={s.wrap}>
        <div style={s.skeletons}>
          <Skeleton height={40} />
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <EmptyState icon="Sparkles" title={t("skills.emptyTitle")} body={t("skills.emptyBody")} />
    );
  }

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.h2}>{t("skills.title")}</h2>
        <Chip icon="Sparkles">
          {t("skills.enabledCount", { linked: linkedIds.length, total: skills.length })}
        </Chip>
        <div style={s.filterBox}>
          <TextInput
            value={filter}
            onChange={setFilter}
            placeholder={t("skills.filterPlaceholder")}
          />
        </div>
      </div>
      <p style={s.caption}>{t("skills.orderHint")}</p>
      {visible.length === 0 ? (
        <div style={s.noMatches}>{t("skills.noMatches")}</div>
      ) : (
        <ul style={s.list}>
          {visible.map((sk) => (
            <SkillRow
              key={sk.id}
              skill={sk}
              linked={displayIds.includes(sk.id)}
              draggable={displayIds.includes(sk.id) && !filtering && !setSkills.isPending}
              dragging={dragId === sk.id}
              onToggle={(on) => toggle(sk.id, on)}
              onDragStart={(e) => startDrag(e, sk.id)}
              onDragOver={(e) => dragOverRow(e, sk.id)}
              onDragEnd={endDrag}
              disabledBadge={t("skills.disabledBadge")}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One skill row: drag handle (linked only), membership checkbox, mono name, badges. */
function SkillRow({
  skill,
  linked,
  draggable,
  dragging,
  onToggle,
  onDragStart,
  onDragOver,
  onDragEnd,
  disabledBadge,
}: {
  skill: Skill;
  linked: boolean;
  draggable: boolean;
  dragging: boolean;
  onToggle: (on: boolean) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  disabledBadge: string;
}) {
  const muted = !skill.enabled;
  return (
    <li
      style={{ ...s.row, ...(muted ? s.rowMuted : {}), ...(dragging ? s.rowDragging : {}) }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
    >
      {draggable ? (
        <span style={s.handle} aria-hidden>
          {DRAG_HANDLE_GLYPH}
        </span>
      ) : (
        <span style={s.handlePlaceholder} aria-hidden />
      )}
      <Checkbox checked={linked} onChange={onToggle} />
      <span className="mono" style={s.name}>
        {skill.name}
      </span>
      <span style={s.badges}>
        <Badge mono>{skill.type}</Badge>
        {muted && <Badge color="var(--text-muted)">{disabledBadge}</Badge>}
      </span>
    </li>
  );
}
