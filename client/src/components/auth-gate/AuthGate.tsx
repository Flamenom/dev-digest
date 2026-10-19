/* AuthGate — mounted by app/layout.tsx inside <Providers> around the app (AC-32, AC-35).

   - local mode (or probe still in flight, or an older API without the probe):
     children render immediately — nothing changes versus before multi-user
     mode, and the server stays the enforcement point.
   - google mode, probe answers 401 `unauthenticated` → one redirect to
     `/sign-in?return_to=<current path>`; the app tree is not rendered, so no
     protected screen mounts and fires its own requests.
   - the sign-in screen itself is never gated (no redirect loop). */
"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { isUnauthenticated, useSession } from "@/lib/hooks";
import { isSignInPath, redirectToSignIn } from "@/lib/sign-in-redirect";
import { s } from "./styles";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const onSignIn = isSignInPath(pathname);
  const { error } = useSession();
  const signedOut = !onSignIn && isUnauthenticated(error);

  React.useEffect(() => {
    if (signedOut) redirectToSignIn();
  }, [signedOut]);

  if (signedOut) return <RedirectingNotice />;
  return <>{children}</>;
}

function RedirectingNotice() {
  const t = useTranslations("auth");
  return (
    <p role="status" style={s.redirecting}>
      {t("signIn.redirecting")}
    </p>
  );
}

export default AuthGate;
