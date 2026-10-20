/* AddRepoView — add-repository screen body. URL only (github.com or
   gitlab.com). API keys (OpenAI / Anthropic / GitHub PAT / GitLab token) are
   NOT entered here; they live in Settings → API Keys and don't change per repo.
   Escapable: Esc or the close button returns to the app.

   A 4xx from POST /repos is silent under the global query error policy, so the
   view renders it inline — known host error codes get a localized message.

   Adding a repository is Admin-only (AC-33): for a Member the submit control
   stays focusable but aria-disabled, with a visible "Admins only" hint. The
   server enforces the rule too (POST /repos → 403 forbidden_role). */
"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Icon, IconBtn, Kbd, TextInput, FormField } from "@devdigest/ui";
import { useAddRepo } from "@/lib/hooks";
import { AdminOnly } from "@/components/admin-gate";
import { useCan } from "@/lib/hooks/permissions";
import { ApiError } from "@/lib/api";
import { addRepoErrorCode } from "./helpers";
import { s } from "./styles";

export function AddRepoView() {
  const t = useTranslations("repos.add");
  const router = useRouter();
  const [repoUrl, setRepoUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const addRepo = useAddRepo();
  const { isAdmin: canAdd } = useCan();

  const close = React.useCallback(() => router.push("/"), [router]);

  // Escapable (the footer advertises Esc — make it real).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const submit = async () => {
    if (!repoUrl.trim() || addRepo.isPending) return;
    setError(null);
    try {
      const repo = await addRepo.mutateAsync(repoUrl.trim());
      router.push(`/repos/${repo.id}/pulls`);
    } catch (e) {
      if (e instanceof ApiError) {
        const code = addRepoErrorCode(e.code);
        setError(code ? t(`errors.${code}`) : e.message);
      } else {
        setError(t("errors.generic"));
      }
    }
  };

  return (
    <div style={s.page}>
      <div style={s.brandRow}>
        <div style={s.brandMark}>
          <Icon.Layers size={17} style={s.brandIcon} />
        </div>
        <span style={s.brandName}>{t("brand")}</span>
      </div>

      <div style={s.card}>
        <div style={s.close}>
          <IconBtn icon="X" label={t("close")} onClick={close} />
        </div>

        <h1 style={s.title}>{t("title")}</h1>
        <p style={s.intro}>
          {t.rich("intro", {
            link: (chunks) => (
              <Link href="/settings/api-keys" style={s.link}>
                {chunks}
              </Link>
            ),
          })}
        </p>

        <FormField label={t("urlLabel")} hint={t("urlHint")}>
          <TextInput
            value={repoUrl}
            onChange={setRepoUrl}
            mono
            placeholder={t("urlPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canAdd) submit();
            }}
          />
        </FormField>

        {error && (
          <div role="alert" style={s.error}>
            <Icon.XCircle size={16} style={s.errorIcon} />
            <span style={s.errorText}>{error}</span>
          </div>
        )}

        <div style={s.actions}>
          <Button kind="ghost" size="md" onClick={close}>
            {t("cancel")}
          </Button>
          <div style={s.spacer} />
          <AdminOnly>
            {(gate) => (
              <Button
                {...gate.controlProps}
                kind="primary"
                size="md"
                icon="Plus"
                onClick={gate.guard(submit)}
                // A Member's control must stay focusable so the hint is
                // reachable — never natively disabled for them.
                disabled={gate.allowed && (!repoUrl.trim() || addRepo.isPending)}
              >
                {addRepo.isPending ? t("cloning") : t("submit")}
              </Button>
            )}
          </AdminOnly>
        </div>
      </div>

      <p style={s.footer}>
        <Icon.Lock size={12} />
        {t.rich("footer", { kbd: (chunks) => <Kbd>{chunks}</Kbd> })}
      </p>
    </div>
  );
}
