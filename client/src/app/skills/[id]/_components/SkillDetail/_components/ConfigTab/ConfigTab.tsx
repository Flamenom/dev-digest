/* ConfigTab — skill configuration (§4.4): Enabled toggle top-right, Name*,
   Description (directive-interface hint), Type, and the skill-body editor.
   When the body changed, Save first asks for an optional one-line version note
   (mini-modal) — the PUT then bumps the version server-side. Delete confirms. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, FormField, Modal, SelectInput, TextInput, Toggle } from "@devdigest/ui";
import type { Skill, SkillType } from "@devdigest/shared";
import { useDeleteSkill, useUpdateSkill } from "@/lib/hooks/skills";
import { useToast } from "@/lib/toast";
import { BodyEditor } from "../../../../../_components/BodyEditor";
import { SKILL_TYPES } from "../../../../../_components/constants";
import { slugify } from "../../../../../_components/helpers";
import { s } from "./styles";

export function ConfigTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  const router = useRouter();
  const toast = useToast();
  const update = useUpdateSkill();
  const del = useDeleteSkill();

  const [name, setName] = React.useState(skill.name);
  const [description, setDescription] = React.useState(skill.description);
  const [type, setType] = React.useState<SkillType>(skill.type);
  const [body, setBody] = React.useState(skill.body);
  const [enabled, setEnabled] = React.useState(skill.enabled);
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [note, setNote] = React.useState("");

  // Reset local form when switching skills.
  React.useEffect(() => {
    setName(skill.name);
    setDescription(skill.description);
    setType(skill.type);
    setBody(skill.body);
    setEnabled(skill.enabled);
    setNoteOpen(false);
    setNote("");
  }, [skill.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const bodyDirty = body !== skill.body;

  const save = (versionNote?: string) =>
    update.mutate(
      {
        id: skill.id,
        patch: {
          name,
          description,
          type,
          body,
          enabled,
          ...(versionNote ? { note: versionNote } : {}),
        },
      },
      {
        onSuccess: (data) => {
          setNoteOpen(false);
          setNote("");
          toast.success(t("config.savedToast", { version: data.version }));
        },
      },
    );

  // A body change snapshots a version — ask for the optional note first.
  const onSave = () => (bodyDirty ? setNoteOpen(true) : save());

  const onDelete = () => {
    if (!window.confirm(t("config.deleteConfirm", { name: skill.name }))) return;
    del.mutate(skill.id, {
      onSuccess: () => {
        toast.success(t("config.deletedToast"));
        router.push("/skills");
      },
    });
  };

  return (
    <div style={s.wrap}>
      {noteOpen && (
        <Modal
          width={480}
          title={t("config.noteTitle")}
          subtitle={t("config.noteSubtitle")}
          onClose={() => setNoteOpen(false)}
          footer={
            <div style={s.noteFooter}>
              <Button kind="tertiary" onClick={() => setNoteOpen(false)}>
                {t("config.noteCancel")}
              </Button>
              <Button kind="primary" icon="Check" onClick={() => save(note.trim() || undefined)} loading={update.isPending}>
                {t("config.noteSave")}
              </Button>
            </div>
          }
        >
          <div style={s.noteBody}>
            <FormField label={t("config.noteLabel")}>
              <TextInput value={note} onChange={setNote} placeholder={t("config.notePlaceholder")} />
            </FormField>
          </div>
        </Modal>
      )}

      <div style={s.header}>
        <h2 style={s.h2}>{t("config.title")}</h2>
        <label style={s.enabledLabel}>
          {t("config.enabled")}
          <Toggle on={enabled} onChange={setEnabled} size={16} />
        </label>
      </div>
      <FormField label={t("config.name")} required>
        <TextInput mono value={name} onChange={setName} />
      </FormField>
      <FormField label={t("config.description")} hint={t("config.descriptionHint")} required>
        <TextInput value={description} onChange={setDescription} />
      </FormField>
      <FormField label={t("config.type")}>
        <SelectInput value={type} onChange={(v) => setType(v as SkillType)} options={[...SKILL_TYPES]} />
      </FormField>
      <FormField label={t("config.body")} required>
        <BodyEditor value={body} onChange={setBody} slug={slugify(name)} dirty={bodyDirty} />
      </FormField>
      <div style={s.actions}>
        <Button kind="primary" icon="Check" onClick={onSave} disabled={update.isPending || !name.trim()}>
          {update.isPending ? t("config.saving") : t("config.save")}
        </Button>
        <div style={s.spacer} />
        <Button kind="danger" icon="Trash" onClick={onDelete} disabled={del.isPending}>
          {t("config.delete")}
        </Button>
      </div>
    </div>
  );
}
