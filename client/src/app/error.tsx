/* Route-segment error boundary (App Router convention). Catches RENDER-time
   throws anywhere below the root layout — the class of failure the per-page
   <ErrorState> blocks (which only handle fetch errors) never see. Without this
   file any render throw escalated to Next's default full-app error screen. */
"use client";

import { useEffect } from "react";
import { ErrorState } from "@devdigest/ui";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the real error for local debugging — the boundary UI only shows
    // a generic message (error.message may contain internals).
    console.error(error);
  }, [error]);

  return (
    <ErrorState
      fullScreen
      title="Something went wrong"
      body="An unexpected error occurred while rendering this page. Retry, or reload the app if it persists."
      onRetry={reset}
    />
  );
}
