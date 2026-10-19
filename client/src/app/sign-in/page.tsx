import { Suspense } from "react";
import { SignInView } from "./_components/SignInView";

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
