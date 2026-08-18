/* /skills layout — master-detail chrome (§4.2): breadcrumb `Skills Lab ›
   Skills` inside the app shell, the persistent SkillsList column on the left
   and the detail slot ({children}) on the right. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { AppShell } from "@/components/app-shell";
import { SkillsList } from "./_components/SkillsList";

const s = {
  row: { display: "flex", height: "calc(100vh - 52px)" } as React.CSSProperties,
  detail: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "auto",
  } as React.CSSProperties,
};

export default function SkillsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("skills");
  return (
    <AppShell crumb={[{ label: t("page.crumbLab") }, { label: t("page.crumbSkills"), href: "/skills" }]}>
      <div style={s.row}>
        <SkillsList />
        <div style={s.detail}>{children}</div>
      </div>
    </AppShell>
  );
}
