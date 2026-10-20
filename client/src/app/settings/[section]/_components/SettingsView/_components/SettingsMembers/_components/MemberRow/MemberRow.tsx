"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, SelectInput } from "@devdigest/ui";
import { Role, type Member, type MemberUpdate } from "@devdigest/shared";
import { ActorAvatar } from "@/components/actor-label";
import { useUpdateMember } from "@/lib/hooks";
import { formatDate } from "../../../../helpers";
import { ROLES } from "../../constants";
import { memberErrorKey } from "../../helpers";
import { s } from "./styles";

export interface MemberRowProps {
  member: Member;
  /** Admin: role selector + Deactivate/Reactivate. Member: list only (UI gating table). */
  canManage: boolean;
  isSelf: boolean;
}

/** One Members-table row. Owns its update mutation so a `last_admin` 409 is shown inline here. */
export function MemberRow({ member, canManage, isSelf }: MemberRowProps) {
  const t = useTranslations("settings");
  const tAuth = useTranslations("auth");
  const update = useUpdateMember();
  const active = member.status === "active";

  const apply = (patch: MemberUpdate) => update.mutate({ userId: member.user_id, patch });
  const roleOptions = ROLES.map((role) => ({ value: role, label: tAuth(`roles.${role}`) }));

  return (
    <tr>
      <td style={s.td}>
        <div style={s.who}>
          <ActorAvatar name={member.name} url={member.avatar_url} size={28} />
          <div style={s.whoText}>
            <div style={s.name}>
              {member.name}
              {isSelf && <span style={s.you}>({t("members.you")})</span>}
            </div>
            <div style={s.email}>{member.email}</div>
          </div>
        </div>
      </td>
      <td style={s.td}>
        {canManage ? (
          <label style={s.roleSelect}>
            <span style={s.srOnly}>{t("members.roleFor", { name: member.name })}</span>
            <SelectInput
              mono={false}
              value={member.role}
              options={roleOptions}
              onChange={(value) => {
                // The select only offers ROLES, but parse rather than cast the DOM value.
                const parsed = Role.safeParse(value);
                if (parsed.success && parsed.data !== member.role) apply({ role: parsed.data });
              }}
            />
          </label>
        ) : (
          tAuth(`roles.${member.role}`)
        )}
      </td>
      <td style={s.td}>
        <span style={s.status(active)}>
          {active ? t("members.statusActive") : t("members.statusDeactivated")}
        </span>
      </td>
      <td style={s.td}>{formatDate(member.joined_at, "—")}</td>
      <td style={s.td}>{formatDate(member.last_sign_in_at, t("members.never"))}</td>
      {canManage && (
        <td style={s.td}>
          <Button
            kind={active ? "danger" : "secondary"}
            size="sm"
            disabled={update.isPending}
            aria-label={
              active
                ? t("members.deactivateLabel", { name: member.name })
                : t("members.reactivateLabel", { name: member.name })
            }
            onClick={() => apply({ status: active ? "deactivated" : "active" })}
          >
            {active ? t("members.deactivate") : t("members.reactivate")}
          </Button>
          {update.isError && (
            <div role="alert" style={s.error}>
              {t(memberErrorKey(update.error))}
            </div>
          )}
        </td>
      )}
    </tr>
  );
}
