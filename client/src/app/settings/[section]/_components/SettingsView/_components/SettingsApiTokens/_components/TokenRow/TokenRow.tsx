"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@devdigest/ui";
import type { ApiTokenListItem } from "@devdigest/shared";
import { useRevokeApiToken } from "@/lib/hooks";
import { formatDate } from "../../../../helpers";
import { s } from "./styles";

/** One personal-token row: name, display prefix, dates, Revoke (AC-55, AC-58). */
export function TokenRow({ token }: { token: ApiTokenListItem }) {
  const t = useTranslations("settings");
  const revoke = useRevokeApiToken();

  return (
    <tr>
      <td style={s.td}>
        <span style={s.name}>{token.name}</span>
      </td>
      <td style={s.td}>
        <code className="mono">{token.prefix}…</code>
      </td>
      <td style={s.td}>{formatDate(token.created_at, "—")}</td>
      <td style={s.td}>{formatDate(token.last_used_at, t("apiTokens.never"))}</td>
      <td style={s.td}>{formatDate(token.expires_at, "—")}</td>
      <td style={s.td}>
        <Button
          kind="danger"
          size="sm"
          disabled={revoke.isPending}
          aria-label={t("apiTokens.revokeLabel", { name: token.name })}
          onClick={() => revoke.mutate(token.id)}
        >
          {t("apiTokens.revoke")}
        </Button>
        {revoke.isError && (
          <div role="alert" style={s.error}>
            {t("apiTokens.errors.revoke")}
          </div>
        )}
      </td>
    </tr>
  );
}
