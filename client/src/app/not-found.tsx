/* App-level 404 (App Router convention) — unknown routes get a styled page
   with a way back instead of Next's default. Note: a stale :repoId on a KNOWN
   route is a different case, handled inline by <RepoNotFound> (the repos list
   is client-fetched, so the server can't 404 it). */
"use client";

import { useRouter } from "next/navigation";
import { EmptyState } from "@devdigest/ui";

export default function NotFound() {
  const router = useRouter();
  return (
    <div style={{ minHeight: "60vh", display: "grid", placeItems: "center" }}>
      <EmptyState
        icon="Search"
        title="Page not found"
        body="This page doesn't exist (or was moved). Head back to the app."
        cta="Go to DevDigest"
        onCta={() => router.push("/")}
      />
    </div>
  );
}
