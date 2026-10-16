/* WindowControl — the `7 / 30 / 90 / All time` date-range control of §8.3.

   It owns no state: the window lives in `?days=` and the parent passes it down,
   so the view survives a reload and is shareable (react-best-practices: URL-
   dependent state belongs in the URL). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { EvalWindowDays } from "@/lib/hooks/eval";
import { WINDOW_OPTIONS } from "../../constants";
import { s } from "./styles";

export interface WindowControlProps {
  value: EvalWindowDays;
  onChange: (value: EvalWindowDays) => void;
}

export function WindowControl({ value, onChange }: WindowControlProps) {
  const t = useTranslations("eval");
  return (
    <div role="group" aria-label={t("dashboard.windowLabel")} style={s.group}>
      {WINDOW_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            style={s.option(active)}
          >
            {t(`dashboard.window.${option.key}`)}
          </button>
        );
      })}
    </div>
  );
}

export default WindowControl;
