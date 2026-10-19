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
  const [copyFailed, setCopyFailed] = React.useState(false);
  // TextInput takes no ref — reach the <input> through its wrapper to select it.
  const valueRef = React.useRef<HTMLDivElement>(null);
  const hintId = React.useId();

  React.useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(id);
  }, [copied]);

  // "Copied" only after the write actually succeeded; on rejection (or no
  // Clipboard API, e.g. a non-secure origin) select the value for a manual copy.
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(token);
      setCopyFailed(false);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
      valueRef.current?.querySelector("input")?.select();
    }
  };

  return (
    <section aria-label={t("apiTokens.createdTitle")} style={s.panel}>
      <div style={s.title}>{t("apiTokens.createdTitle")}</div>
      <p style={s.body}>{t("apiTokens.createdBody")}</p>
      <div style={s.row}>
        <div style={s.value} ref={valueRef}>
          <TextInput
            value={token}
            readOnly
            mono
            aria-label={t("apiTokens.tokenValueLabel")}
            aria-describedby={copyFailed ? hintId : undefined}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
        <Button kind="secondary" size="md" icon={copied ? "Check" : "Copy"} onClick={() => void copy()}>
          {copied ? t("apiTokens.copied") : t("apiTokens.copy")}
        </Button>
        <Button kind="primary" size="md" onClick={onDone}>
          {t("apiTokens.done")}
        </Button>
      </div>
      {copyFailed && (
        <p id={hintId} role="status" style={s.hint}>
          {t("apiTokens.copyFailed")}
        </p>
      )}
    </section>
  );
}
