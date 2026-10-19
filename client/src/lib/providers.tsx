/* providers.tsx — client provider stack: React Query + Theme + Toasts.
   The auth gate + active Repo are composed by the app layer
   (`app/layout.tsx`) INSIDE <Providers>, so shared lib never depends on
   the UI component layer.

   Global error surfacing:
   - 401 `unauthenticated` (google mode, session gone) → ONE redirect to the
     sign-in screen with the current path as return target (AC-35); no toast.
   - 403 `forbidden_role|forbidden_owner|csrf_rejected|session_required` →
     a non-blocking toast + re-read the session so the gating re-renders
     without a reload (AC-34).
   - Otherwise unchanged: mutations always toast; queries toast only on
     network/5xx (expected 4xx stay silent for inline empty states).
   Local mode never returns those codes, so it behaves exactly as before. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
  type QueryKey,
} from "@tanstack/react-query";
import { AuthzErrorCode } from "@devdigest/shared";
import { ThemeProvider } from "./theme";
import { ToastProvider, notify } from "./toast";
import { ApiError } from "./api";
import { SESSION_QUERY_KEY } from "./hooks/session";
import { redirectToSignIn } from "./sign-in-redirect";

const AUTHZ_CODES: ReadonlySet<string> = new Set(AuthzErrorCode.options);

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

function isSessionKey(key: QueryKey | undefined): boolean {
  return key?.[0] === SESSION_QUERY_KEY[0];
}

type AuthzCode = AuthzErrorCode;
type Translate = (key: `toasts.${AuthzCode}`) => string;

export function Providers({ children }: { children: React.ReactNode }) {
  const t = useTranslations("auth");
  // The QueryClient is created once; its handlers read the latest translator.
  const tRef = React.useRef<Translate>(t);
  React.useEffect(() => {
    tRef.current = t;
  });

  const [qc] = React.useState(() => {
    /** Handles the auth-related failures; true = handled (skip the default toast). */
    const handleAuthError = (err: unknown, failedKey?: QueryKey): boolean => {
      if (!(err instanceof ApiError)) return false;
      if (err.status === 401 && err.code === "unauthenticated") {
        redirectToSignIn();
        return true;
      }
      if (err.status === 403 && err.code && AUTHZ_CODES.has(err.code)) {
        notify.error(tRef.current(`toasts.${err.code as AuthzCode}`));
        // Re-read the role (never when the probe itself failed — no refetch loop).
        if (!isSessionKey(failedKey)) {
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        }
        return true;
      }
      return false;
    };

    const client: QueryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: 1,
          staleTime: 30_000,
          refetchOnWindowFocus: false,
        },
      },
      queryCache: new QueryCache({
        onError: (err, query) => {
          if (handleAuthError(err, query.queryKey)) return;
          const status = err instanceof ApiError ? err.status : 500;
          if (status === 0 || status >= 500) notify.error(errorMessage(err));
        },
      }),
      mutationCache: new MutationCache({
        onError: (err) => {
          if (handleAuthError(err)) return;
          notify.error(errorMessage(err));
        },
      }),
    });
    return client;
  });

  return (
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <ToastProvider>{children}</ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
