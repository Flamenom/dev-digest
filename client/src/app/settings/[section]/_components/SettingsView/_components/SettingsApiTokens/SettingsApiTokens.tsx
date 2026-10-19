"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useApiTokens } from "@/lib/hooks";
import { SectionTitle } from "../SectionTitle";
import { CreateTokenForm, type CreatedToken } from "./_components/CreateTokenForm";
import { TokenCreatedPanel } from "./_components/TokenCreatedPanel";
import { TokenRow } from "./_components/TokenRow";
import { TOKEN_COLUMNS } from "./constants";
import { s } from "./styles";

/**
 * Settings → API tokens (google mode only; AC-55, AC-58). Every user manages
 * their own personal tokens. The full value returned by POST /tokens lives
 * ONLY in this component's state: shown once, cleared on Done or reload.
 */
export function SettingsApiTokens() {
  const t = useTranslations("settings");
  const { data: tokens, isPending, isError } = useApiTokens();
  const [created, setCreated] = React.useState<CreatedToken | null>(null);

  return (
    <div style={s.wrap}>
      <SectionTitle title={t("apiTokens.title")} body={t("apiTokens.body")} />
      <CreateTokenForm onCreated={setCreated} />
      {created && <TokenCreatedPanel token={created.token} onDone={() => setCreated(null)} />}

      <h3 style={s.listTitle}>{t("apiTokens.listTitle")}</h3>
      {isPending ? (
        <p style={s.muted}>{t("apiTokens.loading")}</p>
      ) : isError ? (
        <p role="alert" style={s.error}>
          {t("apiTokens.loadFailed")}
        </p>
      ) : tokens.length === 0 ? (
        <p style={s.muted}>{t("apiTokens.empty")}</p>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              {TOKEN_COLUMNS.map((key) => (
                <th key={key} scope="col" style={s.th}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tokens.map((tok) => (
              <TokenRow key={tok.id} token={tok} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
