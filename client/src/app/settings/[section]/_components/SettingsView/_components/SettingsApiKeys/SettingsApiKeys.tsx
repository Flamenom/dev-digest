"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, FormField, TextInput } from "@devdigest/ui";
import type { SecretState } from "@devdigest/shared";
import { useTestConnection, useSecretsStatus } from "@/lib/hooks";
import { ApiError } from "@/lib/api";
import type { ConnTestProviderHost } from "@/lib/types";
import { SectionTitle } from "../SectionTitle";
import { KEY_ROWS, STATE_LABEL_KEY } from "./constants";
import { keyState } from "./helpers";
import { s } from "./styles";

/** "Configured / Not set / Needs re-entry" pill driven by GET /settings/secrets-status. */
function StatusBadge({ state }: { state: SecretState | undefined }) {
  const t = useTranslations("settings");
  if (state === undefined) return null; // status still loading
  return (
    <span style={s.badge(state)}>
      <span style={s.badgeDot(state)} />
      {t(STATE_LABEL_KEY[state])}
    </span>
  );
}

function KeyRow({
  label,
  provider,
  hint,
  state,
}: {
  label: string;
  provider: ConnTestProviderHost;
  hint: string;
  state: SecretState | undefined;
}) {
  const t = useTranslations("settings");
  const [val, setVal] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const test = useTestConnection();
  const [res, setRes] = React.useState<{ ok: boolean; message: string } | null>(null);

  const run = async () => {
    setRes(null);
    try {
      const r = await test.mutateAsync({ provider, key: val.trim() || undefined });
      setRes({ ok: r.ok, message: r.message });
    } catch (e) {
      setRes({ ok: false, message: e instanceof ApiError ? e.message : t("apiKeys.testFailed") });
    }
  };

  return (
    // Named group: FormField's <label> is not bound to the input, so the row and
    // its input carry the provider label for assistive tech (and tests).
    <div role="group" aria-label={label}>
      <FormField label={label} hint={hint} right={<StatusBadge state={state} />}>
        <div style={s.keyRow}>
          <div style={s.keyInput}>
            <TextInput
              value={val}
              onChange={setVal}
              mono
              type={reveal ? "text" : "password"}
              aria-label={label}
              placeholder={t("apiKeys.placeholder")}
              suffix={
                <Icon.EyeOff size={14} style={s.revealIcon} onClick={() => setReveal((r) => !r)} />
              }
            />
          </div>
          <Button kind="secondary" size="md" onClick={run} disabled={test.isPending}>
            {test.isPending ? t("apiKeys.testing") : t("apiKeys.testConnection")}
          </Button>
        </div>
        {res && (
          <div style={s.result(res.ok)}>
            {res.ok ? <Icon.CheckCircle size={13} /> : <Icon.XCircle size={13} />}
            {res.message}
          </div>
        )}
      </FormField>
    </div>
  );
}

/** Member view of one key: label, hint and state badge — no input, no Test (AC-33). */
function ReadOnlyKeyRow({ label, hint, state }: { label: string; hint: string; state: SecretState | undefined }) {
  return (
    <div role="group" aria-label={label} style={s.readOnlyRow}>
      <div style={s.readOnlyText}>
        <div style={s.readOnlyLabel}>{label}</div>
        <div style={s.readOnlyHint}>{hint}</div>
      </div>
      <StatusBadge state={state} />
    </div>
  );
}

/** "Only admins can change API keys" (Member view). */
function ReadOnlyNotice() {
  const t = useTranslations("auth");
  return (
    <div role="note" style={s.notice}>
      <Icon.Info size={15} />
      <span>{t("gate.apiKeysReadOnly")}</span>
    </div>
  );
}

export interface SettingsApiKeysProps {
  /** Member view: state badges only, no inputs or Save & Test (UI gating table). */
  readOnly?: boolean;
}

export function SettingsApiKeys({ readOnly = false }: SettingsApiKeysProps) {
  const t = useTranslations("settings");
  const { data: status } = useSecretsStatus();
  return (
    <div style={s.wrap}>
      <SectionTitle title={t("apiKeys.title")} body={readOnly ? t("apiKeys.readOnlyBody") : t("apiKeys.body")} />
      {readOnly && <ReadOnlyNotice />}
      {KEY_ROWS.map((row) =>
        readOnly ? (
          <ReadOnlyKeyRow
            key={row.provider}
            label={t(row.labelKey)}
            hint={t(row.hintKey)}
            state={keyState(status, row.provider)}
          />
        ) : (
          <KeyRow
            key={row.provider}
            label={t(row.labelKey)}
            provider={row.provider}
            hint={t(row.hintKey)}
            state={keyState(status, row.provider)}
          />
        ),
      )}
    </div>
  );
}
