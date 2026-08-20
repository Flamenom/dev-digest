/* CreateSkillModal — "Create skill from conventions": prefilled from the
   accepted candidates (name, description, generated markdown body), fully
   editable before saving. Saves via the normal POST /skills with
   source 'extracted' + evidence_files provenance, then navigates to the skill
   (ImportSkillModal's confirm idiom). */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, FormField, Icon, Modal, SelectInput, TextInput, Toggle } from "@devdigest/ui";
import type { Convention, SkillType } from "@devdigest/shared";
import { useCreateSkill } from "@/lib/hooks/skills";
import { useToast } from "@/lib/toast";
import { SKILL_TYPES } from "@/app/skills/_components/constants";
import { BodyEditor } from "@/app/skills/_components/BodyEditor";
import { defaultSkillDescription, defaultSkillName, generateSkillBody } from "../../helpers";
import { s } from "./styles";

export function CreateSkillModal({
  repoFullName,
  accepted,
  onClose,
}: {
  repoFullName: string;
  accepted: Convention[];
  onClose: () => void;
}) {
  const t = useTranslations("conventions");
  const router = useRouter();
  const toast = useToast();
  const create = useCreateSkill();

  const [name, setName] = React.useState(() => defaultSkillName(repoFullName));
  const [description, setDescription] = React.useState(() =>
    defaultSkillDescription(repoFullName, accepted.length),
  );
  const [type, setType] = React.useState<SkillType>("convention");
  const [enabled, setEnabled] = React.useState(true);
  const [body, setBody] = React.useState(() => generateSkillBody(repoFullName, accepted));

  const save = () => {
    const evidenceFiles = [...new Set(accepted.map((c) => c.evidence_path))];
    create.mutate(
      {
        name: name.trim(),
        description: description.trim(),
        type,
        body,
        enabled,
        source: "extracted",
        evidence_files: evidenceFiles,
      },
      {
        onSuccess: (skill) => {
          toast.success(t("modal.createdToast", { name: skill.name }));
          onClose();
          router.push(`/skills/${skill.id}`);
        },
      },
    );
  };

  const footer = (
    <div style={s.footer}>
      <Button kind="tertiary" onClick={onClose}>
        {t("modal.cancel")}
      </Button>
      <Button
        kind="primary"
        icon="Sparkles"
        loading={create.isPending}
        disabled={!name.trim() || !body.trim()}
        onClick={save}
      >
        {create.isPending ? t("modal.creating") : t("modal.create")}
      </Button>
    </div>
  );

  return (
    <Modal width={760} title={t("modal.title")} subtitle={name} onClose={onClose} footer={footer}>
      <div style={s.body}>
        <div style={s.banner}>
          <Icon.Brain size={14} style={{ flexShrink: 0 }} />
          <span>
            {t("modal.mergedBanner", { count: accepted.length, repo: repoFullName })}
          </span>
        </div>

        <FormField label={t("modal.name")} required>
          <TextInput mono value={name} onChange={setName} />
        </FormField>

        <FormField label={t("modal.description")}>
          <TextInput value={description} onChange={setDescription} />
        </FormField>

        <div style={s.split}>
          <FormField label={t("modal.type")}>
            <SelectInput
              mono
              value={type}
              onChange={(v) => setType(v as SkillType)}
              options={SKILL_TYPES as unknown as string[]}
            />
          </FormField>
          <FormField label={t("modal.enabled")} hint={t("modal.enabledHint")}>
            <Toggle on={enabled} onChange={setEnabled} />
          </FormField>
        </div>

        <FormField label={t("modal.body")} required>
          <BodyEditor value={body} onChange={setBody} slug={name.trim() || "new-skill"} dirty />
        </FormField>

        {create.isError && <div style={s.error}>{t("modal.createFailed")}</div>}
      </div>
    </Modal>
  );
}

export default CreateSkillModal;
