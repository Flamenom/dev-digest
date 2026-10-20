"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import { useMembers } from "@/lib/hooks";
import { useCan } from "@/lib/hooks/permissions";
import { SectionTitle } from "../SectionTitle";
import { MemberRow } from "./_components/MemberRow";
import { MEMBER_ACTIONS_COLUMN, MEMBER_COLUMNS } from "./constants";
import { s } from "./styles";

/**
 * Settings → Members (AC-19–AC-22). Everyone sees the list; Admins also get the
 * role selector and Deactivate/Reactivate (hidden for Members). The server
 * enforces every rule — this only decides what to offer.
 */
export function SettingsMembers() {
  const t = useTranslations("settings");
  const { isAdmin, userId } = useCan();
  const { data, isPending, isError } = useMembers();
  const columns = isAdmin ? [...MEMBER_COLUMNS, MEMBER_ACTIONS_COLUMN] : MEMBER_COLUMNS;

  return (
    <div style={s.wrap}>
      <SectionTitle title={t("members.title")} body={t("members.body")} />
      {data && !data.has_active_admin && (
        <div role="status" style={s.banner}>
          <Icon.AlertTriangle size={15} style={s.bannerIcon} />
          <span>{t("members.noAdmin")}</span>
        </div>
      )}
      {isPending ? (
        <p style={s.muted}>{t("members.loading")}</p>
      ) : isError ? (
        <p role="alert" style={s.error}>
          {t("members.loadFailed")}
        </p>
      ) : data.members.length === 0 ? (
        <p style={s.muted}>{t("members.empty")}</p>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              {columns.map((key) => (
                <th key={key} scope="col" style={s.th}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <MemberRow key={m.user_id} member={m} canManage={isAdmin} isSelf={m.user_id === userId} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
