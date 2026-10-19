/* ReadOnlyActions — on a read-only host (GitLab) a finding is copied instead of
   posted (AC-43): Copy finding + the shared disabled post control and its
   visible note. */
"use client";

import { useTranslations } from "next-intl";
import { Button } from "@devdigest/ui";
import type { FindingRecord } from "@devdigest/shared";
import { ReadOnlyPostNotice, useCopyToClipboard } from "@/components/read-only-host";
import { findingClipboardText } from "../../helpers";
import { s } from "../../styles";

export function ReadOnlyActions({ f }: { f: FindingRecord }) {
  const t = useTranslations("prHost");
  const copy = useCopyToClipboard();
  return (
    <>
      <Button
        kind="ghost"
        size="sm"
        icon="Copy"
        onClick={() => void copy(findingClipboardText(f, t("finding.suggestedFix")))}
      >
        {t("readOnly.copyFinding")}
      </Button>
      <ReadOnlyPostNotice noteStyle={s.readOnlyNote} />
    </>
  );
}

export default ReadOnlyActions;
