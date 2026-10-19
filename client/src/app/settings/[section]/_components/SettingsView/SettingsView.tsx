/* Settings — left sub-nav + sections. API Keys (OpenRouter + GitHub PAT, with
   Test connection), Feature Models, Members and (google mode only) personal
   API tokens. Section is deep-linked at /settings/:section. Members see API
   Keys and Models read-only (AC-33). */
"use client";

import React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { EmptyState } from "@devdigest/ui";
import { useTranslations } from "next-intl";
import { AppShell } from "@/components/app-shell";
import { useCan } from "@/lib/permissions";
import { SettingsApiKeys } from "./_components/SettingsApiKeys";
import { SettingsModels } from "./_components/SettingsModels";
import { SettingsMembers } from "./_components/SettingsMembers";
import { SettingsApiTokens } from "./_components/SettingsApiTokens";
import {
  DEFAULT_SECTION,
  SECTION_API_KEYS,
  SECTION_API_TOKENS,
  SECTION_MEMBERS,
  SECTION_MODELS,
} from "./constants";
import { visibleSections } from "./helpers";
import { s } from "./styles";

function SectionPane({ section, label, readOnly }: { section: string; label: string; readOnly: boolean }) {
  const t = useTranslations("settings");
  switch (section) {
    case SECTION_API_KEYS:
      return <SettingsApiKeys readOnly={readOnly} />;
    case SECTION_MODELS:
      return <SettingsModels readOnly={readOnly} />;
    case SECTION_MEMBERS:
      return <SettingsMembers />;
    case SECTION_API_TOKENS:
      return <SettingsApiTokens />;
    default:
      return <EmptyState icon="Settings" title={label} body={t("fallbackBody", { label })} />;
  }
}

export function SettingsView() {
  const t = useTranslations("settings");
  const params = useParams<{ section: string }>();
  const perms = useCan();
  const sections = visibleSections(perms.mode, (key) => t(key));
  const requested = params.section ?? DEFAULT_SECTION;
  const current = sections.find((sec) => sec.key === requested) ?? sections[0];
  // An unknown (or mode-hidden) section falls back to the fallback panel, as before.
  const section = sections.some((sec) => sec.key === requested) ? requested : "";
  // No read-only flash for Admins while the session probe is in flight; the
  // server enforces every write regardless.
  const readOnly = !perms.isPending && !perms.isAdmin;

  return (
    <AppShell crumb={[{ label: t("breadcrumb"), href: "/settings/api-keys" }, { label: current.label }]}>
      <div style={s.layout}>
        <div style={s.nav}>
          <h1 style={s.navTitle}>{t("title")}</h1>
          {sections.map((sec) => {
            const on = sec.key === requested;
            return (
              <Link key={sec.key} href={`/settings/${sec.key}`}>
                <div style={s.navItem(on)}>{sec.label}</div>
              </Link>
            );
          })}
        </div>
        <div style={s.pane}>
          <SectionPane section={section} label={current.label} readOnly={readOnly} />
        </div>
      </div>
    </AppShell>
  );
}
