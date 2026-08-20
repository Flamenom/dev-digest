/* NewSkillForm — /skills/new: a blank Config form (name, description with the
   directive-interface hint, type, body editor). On create → redirect to
   /skills/[id]. Manual skills keep the server defaults (source 'manual',
   enabled true). */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, FormField, Icon, SelectInput, TextInput } from "@devdigest/ui";
import type { SkillType } from "@devdigest/shared";
import { useCreateSkill } from "@/lib/hooks/skills";
import { useToast } from "@/lib/toast";
import { BodyEditor } from "../../../_components/BodyEditor";
import { SKILL_TYPES } from "../../../_components/constants";
import { slugify } from "../../../_components/helpers";
import { s } from "./styles";

export function NewSkillForm() {
  const t = useTranslations("skills");
  const router = useRouter();
  const toast = useToast();
  const create = useCreateSkill();

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState<SkillType>("custom");
  const [body, setBody] = React.useState("");

  const canCreate = !!name.trim() && !!description.trim() && !!body.trim();

  const submit = () =>
    create.mutate(
      { name: name.trim(), description: description.trim(), type, body },
      {
        onSuccess: (skill) => {
          toast.success(t("newSkill.createdToast", { name: skill.name }));
          router.push(`/skills/${skill.id}`);
        },
      },
    );

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <Icon.Sparkles size={18} style={{ color: "var(--accent)" }} />
        <h1 style={s.h1}>{t("newSkill.title")}</h1>
      </div>
      <FormField label={t("config.name")} required>
        <TextInput mono value={name} onChange={setName} placeholder={t("file.namePlaceholder")} />
      </FormField>
      <FormField label={t("config.description")} hint={t("config.descriptionHint")} required>
        <TextInput value={description} onChange={setDescription} />
      </FormField>
      <FormField label={t("config.type")}>
        <SelectInput value={type} onChange={(v) => setType(v as SkillType)} options={[...SKILL_TYPES]} />
      </FormField>
      <FormField label={t("config.body")} required>
        <BodyEditor
          value={body}
          onChange={setBody}
          slug={slugify(name)}
          placeholder={t("file.bodyPlaceholder")}
        />
      </FormField>
      <div style={s.actions}>
        <Button kind="primary" icon="Check" onClick={submit} disabled={!canCreate || create.isPending}>
          {create.isPending ? t("newSkill.creating") : t("newSkill.create")}
        </Button>
      </div>
    </div>
  );
}
