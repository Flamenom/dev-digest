/* CopyFindingAction — on GitLab a finding can also be copied as plain text
   (AC-38): the one "Copy finding" button. Posting is not offered from the card. */
"use client";

import { useTranslations } from "next-intl";
import { Button } from "@devdigest/ui";
import type { FindingRecord } from "@devdigest/shared";
import { useCopyToClipboard } from "@/lib/hooks/clipboard";
import { findingClipboardText } from "../../helpers";

export function CopyFindingAction({ f }: { f: FindingRecord }) {
  const t = useTranslations("prHost");
  const copy = useCopyToClipboard();
  return (
    <Button
      kind="ghost"
      size="sm"
      icon="Copy"
      onClick={() => void copy(findingClipboardText(f, t("finding.suggestedFix")))}
    >
      {t("readOnly.copyFinding")}
    </Button>
  );
}

export default CopyFindingAction;
