"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, TextInput } from "@devdigest/ui";
import { COPIED_RESET_MS } from "../../constants";
import { s } from "./styles";

export interface TokenCreatedPanelProps {
  token: string;
  /** Clears the value — after this it can never be shown again (AC-55). */
  onDone: () => void;
}

/** The new token value, shown exactly once, with Copy and Done. */
export function TokenCreatedPanel({ token, onDone }: TokenCreatedPanelProps) {
  const t = useTranslations("settings");
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(token);
    setCopied(true);
  };

  return (
    <section aria-label={t("apiTokens.createdTitle")} style={s.panel}>
      <div style={s.title}>{t("apiTokens.createdTitle")}</div>
      <p style={s.body}>{t("apiTokens.createdBody")}</p>
      <div style={s.row}>
        <div style={s.value}>
          <TextInput
            value={token}
            readOnly
            mono
            aria-label={t("apiTokens.tokenValueLabel")}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
        <Button kind="secondary" size="md" icon={copied ? "Check" : "Copy"} onClick={copy}>
          {copied ? t("apiTokens.copied") : t("apiTokens.copy")}
        </Button>
        <Button kind="primary" size="md" onClick={onDone}>
          {t("apiTokens.done")}
        </Button>
      </div>
    </section>
  );
}
