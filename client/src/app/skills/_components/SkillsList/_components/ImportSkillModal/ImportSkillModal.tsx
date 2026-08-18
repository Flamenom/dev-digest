/* ImportSkillModal — the §4.5 import flow. Step 1: pick a `.md`/`.zip` file →
   POST /skills/import (parse-only preview, persists nothing). Step 2: editable
   name/description/type, rendered body, explicit skipped-entries + warnings
   lists. Confirm → normal POST /skills with source 'community' and
   enabled false ("needs vetting"), then navigate to the new skill. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Card, FormField, Markdown, Modal, SelectInput, TextInput } from "@devdigest/ui";
import type { SkillType } from "@devdigest/shared";
import { useCreateSkill, useImportSkillPreview } from "@/lib/hooks/skills";
import { useToast } from "@/lib/toast";
import { SKILL_TYPES } from "../../../constants";
import { s } from "./styles";

interface Draft {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  skipped: string[];
  warnings: string[];
}

export function ImportSkillModal({ onClose }: { onClose: () => void }) {
  const t = useTranslations("skills");
  const router = useRouter();
  const toast = useToast();
  const preview = useImportSkillPreview();
  const create = useCreateSkill();
  const [file, setFile] = React.useState<File | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);

  const runPreview = () => {
    if (!file) return;
    preview.mutate(file, {
      onSuccess: (p) =>
        setDraft({
          name: p.name,
          description: p.description,
          type: p.suggested_type,
          body: p.body,
          skipped: p.skipped,
          warnings: p.warnings,
        }),
    });
  };

  const confirm = () => {
    if (!draft) return;
    create.mutate(
      {
        name: draft.name,
        description: draft.description,
        type: draft.type,
        body: draft.body,
        source: "community",
        enabled: false,
      },
      {
        onSuccess: (skill) => {
          toast.success(t("import.successToast", { name: skill.name }));
          onClose();
          router.push(`/skills/${skill.id}`);
        },
      },
    );
  };

  const footer = !draft ? (
    <div style={s.footer}>
      <Button kind="tertiary" onClick={onClose}>
        {t("import.cancel")}
      </Button>
      <Button kind="primary" icon="Upload" disabled={!file} loading={preview.isPending} onClick={runPreview}>
        {preview.isPending ? t("import.previewing") : t("import.preview")}
      </Button>
    </div>
  ) : (
    <div style={s.footer}>
      <Button kind="tertiary" onClick={() => setDraft(null)}>
        {t("import.back")}
      </Button>
      <Button kind="tertiary" onClick={onClose}>
        {t("import.cancel")}
      </Button>
      <Button
        kind="primary"
        icon="Check"
        loading={create.isPending}
        disabled={!draft.name.trim() || !draft.body.trim()}
        onClick={confirm}
      >
        {create.isPending ? t("import.confirming") : t("import.confirm")}
      </Button>
    </div>
  );

  return (
    <Modal width={680} title={t("import.title")} subtitle={t("import.subtitle")} onClose={onClose} footer={footer}>
      {!draft ? (
        <div style={s.body}>
          <FormField label={t("import.fileLabel")} hint={t("import.fileHint")} required>
            <input
              type="file"
              accept=".md,.zip"
              aria-label={t("import.fileLabel")}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={s.fileInput}
            />
          </FormField>
          {preview.isError && <div style={s.error}>{t("drawer.importFailed")}</div>}
        </div>
      ) : (
        <div style={s.body}>
          <FormField label={t("import.nameLabel")} required>
            <TextInput mono value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
          </FormField>
          <FormField label={t("import.descriptionLabel")}>
            <TextInput value={draft.description} onChange={(v) => setDraft({ ...draft, description: v })} />
          </FormField>
          <FormField label={t("import.typeLabel")}>
            <SelectInput
              value={draft.type}
              onChange={(v) => setDraft({ ...draft, type: v as SkillType })}
              options={[...SKILL_TYPES]}
            />
          </FormField>
          <FormField label={t("import.bodyLabel")}>
            <Card style={s.bodyCard}>
              <Markdown>{draft.body}</Markdown>
            </Card>
          </FormField>
          {draft.skipped.length > 0 && (
            <div style={s.listBlock}>
              <div style={s.listTitle}>{t("import.skippedTitle")}</div>
              <ul style={s.list}>
                {draft.skipped.map((entry) => (
                  <li key={entry} className="mono" style={s.listItem}>
                    {entry}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {draft.warnings.length > 0 && (
            <div style={s.listBlock}>
              <div style={s.listTitle}>{t("import.warningsTitle")}</div>
              <ul style={s.list}>
                {draft.warnings.map((w) => (
                  <li key={w} style={s.listItem}>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={s.notice}>{t("import.vettingNotice")}</div>
        </div>
      )}
    </Modal>
  );
}
