/* Route: /skills/:id — the selected skill's detail (Config | Preview | Stats |
   Versions). Tab state lives in ?tab= (useQueryParam, same pattern as the
   AgentEditor page). The list column + shell come from the segment layout. */
"use client";

import React from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { ApiError } from "@/lib/api";
import { useSkill } from "@/lib/hooks/skills";
import { useQueryParam } from "@/lib/hooks/use-query-param";
import { SkillDetail } from "./_components/SkillDetail";
import { DEFAULT_TAB, TAB_KEYS } from "./_components/SkillDetail/constants";

export default function SkillDetailPage() {
  const t = useTranslations("skills");
  const { id } = useParams<{ id: string }>();
  const { data: skill, isLoading, isError, error, refetch } = useSkill(id);
  const [tabParam, setTab] = useQueryParam("tab", DEFAULT_TAB);
  const tab = TAB_KEYS.includes(tabParam) ? tabParam : DEFAULT_TAB;

  if (isError) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div style={{ margin: "auto" }}>
          <EmptyState icon="Sparkles" title={t("detail.notFound.title")} body={t("detail.notFound.body")} />
        </div>
      );
    }
    return (
      <ErrorState
        body={error instanceof ApiError ? error.message : t("detail.loadError")}
        onRetry={() => refetch()}
      />
    );
  }

  if (isLoading || !skill) {
    return (
      <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
        <Skeleton height={24} width={240} />
        <Skeleton height={200} />
      </div>
    );
  }

  return <SkillDetail skill={skill} tab={tab} onTab={setTab} />;
}
