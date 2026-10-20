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
   - Otherwise unchanged: mutations toast; queries toast only on
     network/5xx (expected 4xx stay silent for inline empty states).

   One error channel per mutation: a mutation whose caller surfaces the
   failure itself (an inline alert next to its form, or its own specific
   toast) declares `meta: { errorChannel: "local" }` — the global toast is
   then skipped for it (the 401 redirect and the session re-read still run).
   Local mode never returns the auth codes, so it behaves exactly as before. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
  type DefaultOptions,
  type QueryKey,
} from "@tanstack/react-query";
import { AuthzErrorCode } from "@devdigest/shared";
import { ThemeProvider } from "./theme";
import { ToastProvider, notify } from "./toast";
import { ApiError } from "./api";
import { SESSION_QUERY_KEY } from "./hooks/session";
import { redirectToSignIn } from "./sign-in-redirect";
import { isLocalErrorChannel } from "./query-meta";

const AUTHZ_CODES: ReadonlySet<string> = new Set(AuthzErrorCode.options);

/** Type guard: the error code is one of the 403 authz codes (has a toast message). */
export function isAuthzCode(code: string | undefined): code is AuthzErrorCode {
  return code !== undefined && AUTHZ_CODES.has(code);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

function isSessionKey(key: QueryKey | undefined): boolean {
  return key?.[0] === SESSION_QUERY_KEY[0];
}

type Translate = (key: `toasts.${AuthzErrorCode}`) => string;

export interface ProvidersProps {
  children: React.ReactNode;
  /** Merged over the app's query defaults (tests pass `{ retry: false }`). */
  queryDefaults?: DefaultOptions["queries"];
}

export function Providers({ children, queryDefaults }: ProvidersProps) {
  const t = useTranslations("auth");
  // The QueryClient is created once; its handlers read the latest translator.
  const tRef = React.useRef<Translate>(t);
  React.useEffect(() => {
    tRef.current = t;
  });

  const [qc] = React.useState(() => {
    /**
     * Handles the auth-related failures; true = handled (skip the default toast).
     * `silent` = the caller owns the error channel: no toast, side effects only.
     */
    const handleAuthError = (err: unknown, failedKey: QueryKey | undefined, silent: boolean): boolean => {
      if (!(err instanceof ApiError)) return false;
      if (err.status === 401 && err.code === "unauthenticated") {
        redirectToSignIn();
        return true;
      }
      if (err.status === 403 && isAuthzCode(err.code)) {
        if (!silent) notify.error(tRef.current(`toasts.${err.code}`));
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
          ...queryDefaults,
        },
      },
      queryCache: new QueryCache({
        onError: (err, query) => {
          if (handleAuthError(err, query.queryKey, false)) return;
          const status = err instanceof ApiError ? err.status : 500;
          if (status === 0 || status >= 500) notify.error(errorMessage(err));
        },
      }),
      mutationCache: new MutationCache({
        onError: (err, _vars, _ctx, mutation) => {
          const local = isLocalErrorChannel(mutation.options.meta);
          if (handleAuthError(err, undefined, local)) return;
          if (!local) notify.error(errorMessage(err));
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
