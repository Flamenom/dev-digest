/* SnippetBlock — evidence excerpt: mono header with the `path:lines` label,
   an optional GitHub ↗ link to the evidence lines, and a copy button
   (PromptBlock idiom), plus the verbatim snippet in a code well. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import { s } from "./styles";

export function SnippetBlock({
  label,
  snippet,
  href,
}: {
  label: string;
  snippet: string;
  /** External link for the evidence (GitHub blob URL); omitted → no link. */
  href?: string | null;
}) {
  const t = useTranslations("conventions");
  const [copied, setCopied] = React.useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div style={s.frame}>
      <div style={s.header}>
        <span className="mono" style={s.label}>
          {label}
        </span>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title={t("card.viewOnGitHub")}
            style={s.githubLink}
          >
            {t("card.viewOnGitHub")}
            <Icon.ExternalLink size={11} />
          </a>
        )}
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? t("card.copied") : t("card.copy")}
          title={copied ? t("card.copied") : t("card.copy")}
          style={s.copyBtn}
        >
          {copied ? <Icon.Check size={12} /> : <Icon.Copy size={12} />}
        </button>
      </div>
      <pre className="mono" style={s.pre}>
        {snippet || "—"}
      </pre>
    </div>
  );
}

export default SnippetBlock;
