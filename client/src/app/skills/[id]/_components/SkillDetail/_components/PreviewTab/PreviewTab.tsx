/* PreviewTab — the skill body rendered exactly as the reviewing agent
   receives it (kit Markdown inside a Card). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Card, Markdown } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { s } from "./styles";

export function PreviewTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  return (
    <div style={s.wrap}>
      <div style={s.subtitle}>{t("preview.subtitle")}</div>
      <Card style={s.card}>
        <Markdown>{skill.body}</Markdown>
      </Card>
    </div>
  );
}
