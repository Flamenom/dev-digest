/* SkillsList — the persistent master column of the /skills master-detail
   layout (§4.3): header + "Add Skill ▾" dropdown (create manually / import
   from file), a client-side search filter over name+type, and a SkillCard per
   skill with the global enabled Toggle (optimistic PUT). */
"use client";

import React from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Dropdown, EmptyState, ErrorState, Icon, Skeleton } from "@devdigest/ui";
import { useSkills, useSkillsUsage, useUpdateSkill } from "@/lib/hooks/skills";
import { SkillCard } from "./_components/SkillCard";
import { ImportSkillModal } from "./_components/ImportSkillModal";
import { filterSkills, usageCounts } from "./helpers";
import { s } from "./styles";

export function SkillsList() {
  const t = useTranslations("skills");
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const activeId = typeof params?.id === "string" ? params.id : null;

  const { data: skills, isLoading, isError, refetch } = useSkills();
  const { data: usage } = useSkillsUsage();
  const update = useUpdateSkill();
  const [search, setSearch] = React.useState("");
  const [importing, setImporting] = React.useState(false);

  const list = filterSkills(skills ?? [], search);
  const counts = usageCounts(usage);

  return (
    <div style={s.column}>
      {importing && <ImportSkillModal onClose={() => setImporting(false)} />}
      <div style={s.header}>
        <h1 style={s.h1}>{t("page.heading")}</h1>
        <Dropdown
          width={210}
          align="right"
          trigger={
            <Button kind="primary" size="sm" icon="Plus" iconRight="ChevronDown">
              {t("page.addSkill")}
            </Button>
          }
          items={[
            { label: t("page.menu.createManually"), icon: "Edit", onClick: () => router.push("/skills/new") },
            { label: t("page.menu.fromFile"), icon: "Upload", onClick: () => setImporting(true) },
          ]}
        />
      </div>
      <div style={s.search}>
        <Icon.Search size={13} style={s.searchIcon} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("page.searchPlaceholder")}
          style={s.searchInput}
        />
      </div>
      <div style={s.cards}>
        {isLoading && (
          <div style={s.skeletons}>
            <Skeleton height={110} />
            <Skeleton height={110} />
            <Skeleton height={110} />
          </div>
        )}
        {isError && <ErrorState body={t("page.loadError")} onRetry={() => refetch()} />}
        {!isLoading && !isError && list.length === 0 && (
          <EmptyState
            icon="Sparkles"
            title={t("page.empty.title")}
            body={t("page.empty.body")}
            cta={t("page.empty.cta")}
            onCta={() => setImporting(true)}
          />
        )}
        {list.map((sk) => (
          <SkillCard
            key={sk.id}
            skill={sk}
            active={sk.id === activeId}
            agentCount={counts.get(sk.id) ?? 0}
            onClick={() => router.push(`/skills/${sk.id}`)}
            onToggle={(enabled) => update.mutate({ id: sk.id, patch: { enabled } })}
          />
        ))}
      </div>
    </div>
  );
}
