/* BodyEditor — the skill-body markdown editor per the L02 design: a chrome bar
   with a `<slug>.md` filename chip, an `unsaved` chip when dirty and a live
   `~N tokens` counter (js-tiktoken), over a Textarea with a line-number gutter.
   No editor library. Long lines soft-wrap; the gutter numbers LOGICAL lines
   (one number per '\n' line, wrapped continuations get none), so each gutter
   entry's height is measured from a hidden mirror <div> that reproduces the
   textarea's exact text metrics. The textarea is sized to its full content
   (no inner scroll) and the shared scroller scrolls gutter + text together. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import { useTokenCount } from "./use-token-count";
import { s, LINE_HEIGHT } from "./styles";

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
  const logicalLines = React.useMemo(() => value.split("\n"), [value]);
  const totalLines = Math.max(MIN_LINES, logicalLines.length + 1);

  const mirrorRef = React.useRef<HTMLDivElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [lineHeights, setLineHeights] = React.useState<number[]>([]);
  const [width, setWidth] = React.useState(0);

  // Re-measure when the editor's width changes (modal vs page, window resize).
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    const mirror = mirrorRef.current;
    if (!mirror) return;
    setLineHeights(
      Array.from(mirror.children, (c) => (c as HTMLElement).offsetHeight || LINE_HEIGHT),
    );
  }, [logicalLines, width]);

  const heightOf = (i: number) =>
    i < logicalLines.length ? (lineHeights[i] ?? LINE_HEIGHT) : LINE_HEIGHT;
  // Full content height (+ the textarea's 10px top/bottom padding) so the
  // textarea never scrolls internally — the outer scroller owns scrolling.
  const textHeight =
    Array.from({ length: totalLines }, (_, i) => heightOf(i)).reduce((a, b) => a + b, 0) + 20;

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
          {Array.from({ length: totalLines }, (_, i) => (
            <div key={i} style={s.gutterLine(heightOf(i))}>
              {i + 1}
            </div>
          ))}
        </div>
        <div ref={wrapRef} style={s.textWrap}>
          <div ref={mirrorRef} aria-hidden className="mono" style={s.mirror}>
            {logicalLines.map((line, i) => (
              <div key={i}>{line === "" ? " " : line}</div>
            ))}
          </div>
          <textarea
            className="mono"
            aria-label={t("config.body")}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...s.textarea, height: textHeight }}
            spellCheck={false}
            wrap="soft"
          />
        </div>
      </div>
    </div>
  );
}
