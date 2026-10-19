/* ReadOnlyPostNotice — a read-only host's (GitLab) disabled "post" control plus
   the VISIBLE note that explains it, linked via aria-describedby so the reason
   is keyboard/screen-reader reachable, never hover-only (AC-43).

   Renders a fragment so it drops into the caller's flex row; `children` sit
   between the button and the note (e.g. a composer's Cancel / Copy). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@devdigest/ui";

type ButtonKind = React.ComponentProps<typeof Button>["kind"];

export function ReadOnlyPostNotice({
  label,
  kind = "ghost",
  noteStyle,
  children,
}: {
  /** Label of the disabled post control. Defaults to "Post comment". */
  label?: string;
  kind?: ButtonKind;
  noteStyle?: React.CSSProperties;
  /** Extra controls rendered between the post button and the note. */
  children?: React.ReactNode;
}) {
  const t = useTranslations("prHost");
  const noteId = React.useId();
  return (
    <>
      <Button kind={kind} size="sm" icon="MessageSquare" disabled aria-describedby={noteId}>
        {label ?? t("readOnly.postComment")}
      </Button>
      {children}
      <span id={noteId} style={noteStyle}>
        {t("readOnly.note")}
      </span>
    </>
  );
}

export default ReadOnlyPostNotice;
