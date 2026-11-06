/* monitoring/sentry.ts — opt-in, errors-only browser Sentry (AC-33, AC-35, AC-36, AC-38–AC-40).

   - Empty build-time DSN → `initMonitoring()` returns BEFORE the dynamic
     `import("./sdk")` (the only `@sentry/browser` importer): no SDK chunk is fetched, no request reaches
     any Sentry host, the app behaves exactly as without monitoring.
   - Errors only: `defaultIntegrations: false` with an explicit minimal list
     (global onerror/unhandledrejection, linked errors, dedupe). No tracing,
     no replay, no profiling options are ever set; breadcrumbs are off.
   - API error responses are NOT reported (the API reports its own 5xx):
     `beforeSend` drops any event whose original exception is shaped
     `{ name: "ApiError" }` (matched by shape, not `instanceof`).
   - Every event goes through `scrubEvent` before it leaves the browser.

   Until init completes, `reportRenderError` / `setMonitoringUser` are no-ops. */

import type { ErrorEvent, EventHint } from "@sentry/browser";
import { readMonitoringConfig } from "./config";
import { scrubEvent } from "./scrub";

type Capture = (err: unknown) => void;
type SetUser = (user: { id: string } | null) => void;

let capture: Capture | null = null;
let setUser: SetUser | null = null;
let pendingUserId: string | null | undefined;
let initPromise: Promise<boolean> | null = null;

/** True for the client's `ApiError` (or anything carrying its name) — matched by shape. */
export function isApiErrorShape(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ApiError"
  );
}

/** The `beforeSend` hook: drop API errors (AC-35), scrub everything else (AC-36). */
export function beforeSend(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  if (isApiErrorShape(hint?.originalException)) return null;
  return scrubEvent(event);
}

async function doInit(): Promise<boolean> {
  const config = readMonitoringConfig();
  if (!config.dsn) return false;

  const Sentry = await import("./sdk");
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    defaultIntegrations: false,
    integrations: [
      Sentry.globalHandlersIntegration({ onerror: true, onunhandledrejection: true }),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
    ],
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    // v11 replaced `sendDefaultPii` with per-category `dataCollection`: collect nothing.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    sendClientReports: false,
    beforeSend,
  });

  capture = (err) => {
    Sentry.captureException(err);
  };
  setUser = (user) => {
    Sentry.setUser(user);
  };
  if (pendingUserId !== undefined) setUser(pendingUserId ? { id: pendingUserId } : null);
  return true;
}

/**
 * Initialises browser monitoring once. Resolves `true` when the SDK is active,
 * `false` when the DSN is empty or the SDK failed to load (never throws — a
 * monitoring failure must not break the app).
 */
export function initMonitoring(): Promise<boolean> {
  initPromise ??= doInit().catch(() => false);
  return initPromise;
}

/** Reports an error caught by a React error boundary. No-op until init / when disabled. */
export function reportRenderError(err: unknown): void {
  try {
    capture?.(err);
  } catch {
    // Monitoring must never turn an error page into a crash.
  }
}

/** Tags subsequent events with the internal user id only (AC-38); `null` clears it. */
export function setMonitoringUser(id: string | null): void {
  pendingUserId = id;
  try {
    setUser?.(id ? { id } : null);
  } catch {
    // ignore — see reportRenderError
  }
}

/** Test-only: forget the init state so each test starts from scratch. */
export function __resetMonitoringForTests(): void {
  capture = null;
  setUser = null;
  pendingUserId = undefined;
  initPromise = null;
}
