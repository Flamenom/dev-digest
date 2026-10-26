/* PublishProgress — a publication's live progress and its result (AC-39).
   - in_progress → "Publishing k of N…" in a polite live region;
   - published → `role="status"`: count, MR link, other drafts published with it;
     a deprecated publication reads "… as deprecated" plus "M were posted as
     general MR comments" when M > 0 (spec 2026-10-23, AC-24);
   - partially_published → a `role="status"` summary + a `role="alert"` list of
     each failed finding with its reason;
   - failed → `role="alert"` with the code's message + "Try again";
   - unconfirmed → `role="alert"` with the message + "Check GitLab".
   Presentational: the publication comes from `usePublication` (it polls). The
   MR URL is validated (http/https) before it reaches an `href`. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@devdigest/ui";
import type { Publication, PublicationWithDeprecation } from "@/lib/types";
import { isSafeHttpUrl, knownPublishCode, progressDone } from "../helpers";
import { s } from "./styles";

export interface PublishProgressProps {
  /** A base or deprecation-aware publication (`deprecated` drives the AC-24 wording). */
  publication: Publication | PublicationWithDeprecation;
  /** The MR's web URL (e.g. `hostPrUrl(repo, iid)`); unsafe / null → no link. */
  mrUrl?: string | null;
  /** Title of a finding, for the failed-findings list (falls back to the id). */
  findingTitle?: (findingId: string) => string | undefined;
  /** "Try again" on a failed publication — the caller clears the result and re-opens the dialog. */
  onTryAgain?: () => void;
}

/** The MR link — rendered only for a validated http/https URL. */
function MrLink({ url, label }: { url: string | null; label: string }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={s.link}>
      {label}
      <Icon.ExternalLink size={12} aria-hidden />
    </a>
  );
}

export function PublishProgress({ publication: p, mrUrl, findingTitle, onTryAgain }: PublishProgressProps) {
  const t = useTranslations("prHost.publish");
  const safeMrUrl = isSafeHttpUrl(mrUrl) ? mrUrl : null;
  const messageFor = (code: string | null | undefined, fallback?: string | null) => {
    const known = knownPublishCode(code);
    return known ? t(`code.${known}`) : (fallback ?? code ?? "");
  };

  if (p.status === "in_progress") {
    return (
      <div role="status" aria-live="polite" style={s.progress}>
        {t("progress", { done: progressDone(p), total: p.requested })}
      </div>
    );
  }

  if (p.status === "published" || p.status === "partially_published") {
    const failedItems = p.items.filter((i) => i.state === "failed");
    const deprecated = "deprecated" in p && p.deprecated;
    const publishedText = deprecated
      ? t("result.publishedDeprecated", { count: p.published })
      : t("result.published", { count: p.published });
    return (
      <div style={s.stack}>
        <div role="status" style={s.success}>
          <span>
            {p.status === "published"
              ? publishedText
              : t("result.partial", { published: p.published, failed: p.failed })}
          </span>
          {deprecated && p.general_notes > 0 && <span>{t("result.generalCount", { count: p.general_notes })}</span>}
          {p.other_drafts_published > 0 && <span>{t("result.otherDrafts", { count: p.other_drafts_published })}</span>}
          <MrLink url={safeMrUrl} label={t("result.viewMr")} />
        </div>
        {failedItems.length > 0 && (
          <div role="alert" style={s.failure}>
            <ul style={s.list}>
              {failedItems.map((item) => (
                <li key={item.finding_id}>
                  {findingTitle?.(item.finding_id) ?? item.finding_id} — {messageFor(item.code)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // failed | unconfirmed
  return (
    <div role="alert" style={s.failure}>
      <span>{messageFor(p.code ?? (p.status === "unconfirmed" ? "gitlab_publish_unconfirmed" : null), p.message)}</span>
      <div style={s.row}>
        {p.status === "failed" && onTryAgain && (
          <Button kind="secondary" size="sm" icon="RefreshCw" onClick={onTryAgain}>
            {t("result.tryAgain")}
          </Button>
        )}
        {p.status === "unconfirmed" && <MrLink url={safeMrUrl} label={t("result.checkGitLab")} />}
      </div>
    </div>
  );
}

export default PublishProgress;
