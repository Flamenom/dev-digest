/* DiffModal — client-side line diff of a version vs its previous version
   (pure LCS helper in ../../..//helpers.ts, no dependency). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@devdigest/ui";
import type { SkillVersionEntry } from "@devdigest/shared";
import { diffLines } from "../../../../helpers";
import { s } from "../../styles";

export function DiffModal({
  from,
  to,
  onClose,
}: {
  from: SkillVersionEntry;
  to: SkillVersionEntry;
  onClose: () => void;
}) {
  const t = useTranslations("skills");
  const lines = React.useMemo(() => diffLines(from.body, to.body), [from.body, to.body]);
  const changed = lines.some((l) => l.kind !== "same");

  return (
    <Modal width={720} title={t("versions.diffTitle", { from: from.version, to: to.version })} onClose={onClose}>
      <div className="mono" style={s.diffBody}>
        {!changed ? (
          <div style={s.diffEmpty}>{t("versions.diffEmpty")}</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} style={s.diffLine(line.kind)}>
              <span style={s.diffSign}>
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
              </span>
              <span>{line.text || " "}</span>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
