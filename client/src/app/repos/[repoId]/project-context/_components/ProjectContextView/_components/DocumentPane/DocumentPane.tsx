/* DocumentPane — inline Preview/Edit pane for the selected document (replaces
   the former DocumentDrawer). Header: filename + Preview/Edit segmented toggle
   (aria-pressed) + right-aligned "Used by N agents". Preview renders markdown
   (AC-31 toggle target); Edit is a keyboard-operable textarea over the raw
   markdown with Save via useSaveDocument. Save success/failure is announced
   through an aria-live region, and the resync-clobber warning is shown for
   every doc (no cheap tracked-file detection exists — AC-34). The parent keys
   this component by path so Preview/Edit + draft state reset per document. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, Markdown, Skeleton, Textarea } from "@devdigest/ui";
import type { DiscoveredDocument } from "@devdigest/shared";
import { useDocument, useSaveDocument } from "@/lib/hooks/projectContext";
import { splitPath } from "../../helpers";
import { s } from "./styles";

export function DocumentPane({ repoId, doc }: { repoId: string; doc: DiscoveredDocument }) {
  const t = useTranslations("projectContext");
  const docQ = useDocument(repoId, doc.path);
  const save = useSaveDocument(repoId);
  const [mode, setMode] = React.useState<"preview" | "edit">("preview");
  // Draft is null until the user types — the displayed text derives from the
  // fetched document until then (derive, don't store).
  const [draft, setDraft] = React.useState<string | null>(null);

  const text = draft ?? docQ.data?.text ?? "";
  const { name } = splitPath(doc.path);

  let body: React.ReactNode;
  if (docQ.isLoading) {
    body = <Skeleton height={160} />;
  } else if (docQ.isError) {
    body = <div style={s.muted}>{t("drawer.loadError")}</div>;
  } else if (mode === "preview") {
    body = <Markdown>{text}</Markdown>;
  } else {
    body = (
      <>
        <div style={s.warning}>
          <Icon.AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{t("drawer.resyncWarning")}</span>
        </div>
        <label style={s.editor}>
          {t("drawer.editorLabel")}
          <Textarea value={text} onChange={setDraft} rows={18} mono />
        </label>
      </>
    );
  }

  return (
    <section style={s.pane} aria-label={doc.path}>
      <header style={s.header}>
        <span className="mono" style={s.title} title={doc.path}>
          {name}
        </span>
        <div style={s.tabs}>
          <Button
            kind="tertiary"
            size="sm"
            icon="Eye"
            active={mode === "preview"}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            {t("drawer.previewTab")}
          </Button>
          <Button
            kind="tertiary"
            size="sm"
            icon="Edit"
            active={mode === "edit"}
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
          >
            {t("drawer.editTab")}
          </Button>
        </div>
        <span style={s.usedBy}>
          <Icon.Users size={13} />
          {t("pane.usedByAgents", { count: doc.used_by_agents ?? 0 })}
        </span>
      </header>
      <div style={s.body}>{body}</div>
      {mode === "edit" && !docQ.isLoading && !docQ.isError && (
        <div style={s.footerRow}>
          <Button
            kind="primary"
            size="sm"
            loading={save.isPending}
            onClick={() => save.mutate({ path: doc.path, text })}
          >
            {save.isPending ? t("drawer.saving") : t("drawer.save")}
          </Button>
          <span aria-live="polite" style={s.saveStatus}>
            {save.isSuccess && <span style={s.saveSuccess}>{t("drawer.saveSuccess")}</span>}
            {save.isError && <span style={s.saveFailure}>{t("drawer.saveFailure")}</span>}
          </span>
        </div>
      )}
    </section>
  );
}

export default DocumentPane;
