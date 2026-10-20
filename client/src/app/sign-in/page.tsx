import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SignInView } from "./_components/SignInView";

/** Tab title for the sign-in screen; never indexed (it is an auth entry point). */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("signIn.metaTitle"), robots: { index: false, follow: false } };
}

/* Route: /sign-in (google mode). Thin route entry — the view reads
   `?return_to` / `?error` via useSearchParams, so it sits in its own Suspense
   boundary (the root layout has one too; this keeps the route self-contained). */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInView />
    </Suspense>
  );
}
