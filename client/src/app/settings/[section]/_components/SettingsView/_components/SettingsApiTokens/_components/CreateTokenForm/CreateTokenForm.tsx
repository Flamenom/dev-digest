"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, FormField, TextInput } from "@devdigest/ui";
import { useCreateApiToken } from "@/lib/hooks";
import { TOKEN_EXPIRY_DEFAULT_DAYS, TOKEN_NAME_MAX } from "../../constants";
import { createErrorKey, validateTokenForm } from "../../helpers";
import { s } from "./styles";

export interface CreatedToken {
  name: string;
  token: string;
}

export interface CreateTokenFormProps {
  /** Receives the full value exactly once; the caller keeps it in component state only. */
  onCreated: (created: CreatedToken) => void;
}

/** Name (1–64) + expiry (1–365 days, default 90) → POST /tokens (AC-55). */
export function CreateTokenForm({ onCreated }: CreateTokenFormProps) {
  const t = useTranslations("settings");
  const create = useCreateApiToken();
  const [name, setName] = React.useState("");
  const [days, setDays] = React.useState(String(TOKEN_EXPIRY_DEFAULT_DAYS));
  const [errorKey, setErrorKey] = React.useState<string | null>(null);
  const errorId = React.useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = validateTokenForm(name, days);
    if (!parsed.ok) {
      setErrorKey(parsed.errorKey);
      return;
    }
    setErrorKey(null);
    try {
      const res = await create.mutateAsync(parsed.input);
      onCreated({ name: res.name, token: res.token });
      // Drop the value from the mutation observer right away — it must not
      // linger outside the caller's component state.
      create.reset();
      setName("");
      setDays(String(TOKEN_EXPIRY_DEFAULT_DAYS));
    } catch (err) {
      setErrorKey(createErrorKey(err));
    }
  };

  const describedBy = errorKey ? errorId : undefined;
  return (
    <form onSubmit={submit} noValidate>
      <div style={s.form}>
        <div style={s.name}>
          <FormField label={t("apiTokens.nameLabel")}>
            <TextInput
              value={name}
              onChange={setName}
              aria-label={t("apiTokens.nameLabel")}
              aria-describedby={describedBy}
              aria-invalid={errorKey === "apiTokens.nameInvalid" || undefined}
              maxLength={TOKEN_NAME_MAX}
              placeholder={t("apiTokens.namePlaceholder")}
            />
          </FormField>
        </div>
        <div style={s.days}>
          <FormField label={t("apiTokens.expiryLabel")}>
            <TextInput
              value={days}
              onChange={setDays}
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              aria-label={t("apiTokens.expiryLabel")}
              aria-describedby={describedBy}
              aria-invalid={errorKey === "apiTokens.expiryInvalid" || undefined}
            />
          </FormField>
        </div>
        <div style={s.submit}>
          <Button type="submit" kind="primary" size="md" disabled={create.isPending}>
            {create.isPending ? t("apiTokens.creating") : t("apiTokens.create")}
          </Button>
        </div>
      </div>
      {errorKey && (
        <div id={errorId} role="alert" style={s.error}>
          {t(errorKey)}
        </div>
      )}
    </form>
  );
}
