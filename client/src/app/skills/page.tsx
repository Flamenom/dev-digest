/* Route: /skills — empty detail state ("Select a skill"). The list column and
   chrome live in the segment layout. */
"use client";

import { useTranslations } from "next-intl";
import { EmptyState } from "@devdigest/ui";

export default function SkillsPage() {
  const t = useTranslations("skills");
  return (
    <div style={{ margin: "auto" }}>
      <EmptyState icon="Sparkles" title={t("page.selectPrompt.title")} body={t("page.selectPrompt.body")} />
    </div>
  );
}
