/* BodyEditor — the skill-body markdown editor per the L02 design: a chrome bar
   with a `<slug>.md` filename chip, an `unsaved` chip when dirty and a live
   `~N tokens` counter (js-tiktoken), over a Textarea with a line-number gutter.
   No editor library — the gutter is a plain flex column; the textarea grows
   with its content (rows = line count) so gutter and text scroll together. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import { useTokenCount } from "./use-token-count";
import { s } from "./styles";

const MIN_LINES = 12;

export function BodyEditor({
  value,
  onChange,
  slug,
  dirty,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  slug: string;
  dirty?: boolean;
  placeholder?: string;
}) {
  const t = useTranslations("skills");
  const tokens = useTokenCount(value);
  const lines = Math.max(MIN_LINES, value.split("\n").length + 1);

  return (
    <div style={s.frame}>
      <div style={s.chrome}>
        <span className="mono" style={s.filename}>
          <Icon.FileText size={12} />
          {slug}.md
        </span>
        {dirty && <span style={s.unsaved}>{t("config.unsaved")}</span>}
        <span className="mono tnum" style={s.tokens}>
          {tokens != null ? t("config.tokens", { count: tokens }) : ""}
        </span>
      </div>
      <div style={s.scroller}>
        <div aria-hidden style={s.gutter}>
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} style={s.gutterLine}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          className="mono"
          aria-label={t("config.body")}
          value={value}
          rows={lines}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={s.textarea}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
