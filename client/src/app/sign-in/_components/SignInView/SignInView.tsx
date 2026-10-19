/* SignInView — the google-mode sign-in screen (AC-6, AC-14, AC-15).

   - One "Sign in with Google" action: a full navigation to the API's
     `/auth/google/start?return_to=…` (the return target is re-validated
     client-side here and server-side, AC-16).
   - Names the allowed domain when known (the signed-out probe's error
     details); otherwise a domain-less subtitle.
   - `?error=<code>` is untrusted: it is mapped to an `auth.errors.*` message
     and never rendered raw (unknown → generic). `auth_idp_unavailable` offers
     "Try again".
   - Already signed in (or local mode) → straight back to the return target. */
"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import { API_BASE } from "../../../../lib/api";
import { useSession } from "../../../../lib/hooks/session";
import { safeReturnTo } from "@/lib/sign-in-redirect";
import { RETRYABLE_ERROR_CODES } from "./constants";
import { buildStartHref, allowedDomainFromProbe, errorMessageKey } from "./helpers";
import { s } from "./styles";

export function SignInView() {
  const t = useTranslations("auth");
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params?.get("return_to"));
  const errorCode = params?.get("error") ?? null;
  const { data: session, error, isPending } = useSession();

  React.useEffect(() => {
    if (session) router.replace(returnTo);
  }, [session, returnTo, router]);

  // Probe in flight, or signed in and leaving: render nothing that could flash.
  if (isPending || session) return <main aria-busy="true" style={s.pending} />;

  const domain = allowedDomainFromProbe(error);
  const startHref = buildStartHref(API_BASE, returnTo);
  const errorKey = errorCode ? errorMessageKey(errorCode, domain) : null;

  return (
    <main style={s.page}>
      <section aria-labelledby="sign-in-title" style={s.card}>
        <div style={s.brand}>
          <span style={s.brandMark} aria-hidden="true">
            <Icon.Layers size={16} style={s.brandIcon} />
          </span>
          <span style={s.brandName}>DevDigest</span>
        </div>
        <div>
          <h1 id="sign-in-title" style={s.title}>
            {t("signIn.title")}
          </h1>
          <p style={s.subtitle}>
            {domain ? t("signIn.subtitle", { domain }) : t("signIn.subtitleGeneric")}
          </p>
        </div>
        {errorKey && (
          <div role="alert" style={s.alert}>
            <span>
              {errorKey === "auth_domain_not_allowed" && domain
                ? t("errors.auth_domain_not_allowed", { domain })
                : t(`errors.${errorKey}`)}
            </span>
            {errorCode && RETRYABLE_ERROR_CODES.has(errorCode) && (
              <a href={startHref} style={s.retryAction}>
                {t("signIn.tryAgain")}
              </a>
            )}
          </div>
        )}
        <a href={startHref} style={s.primaryAction}>
          {t("signIn.action")}
        </a>
      </section>
    </main>
  );
}

export default SignInView;
