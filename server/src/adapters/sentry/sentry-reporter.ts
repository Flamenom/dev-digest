/**
 * Sentry adapter for the `ErrorReporter` port — the ONLY `@sentry/node`
 * importer in the codebase (reviewer-core is gated by `core-no-sentry`).
 * Built once by the composition root when a DSN is configured.
 *
 * Errors only (AC-40): no tracing, no profiling, no OpenTelemetry setup, no
 * default integrations (so no HTTP/console/fs instrumentation and no SDK
 * process handlers — `server.ts` owns those), no breadcrumbs, no local
 * variables, no request data/cookies/headers/query/user collection.
 * Every event passes `scrubEvent` in `beforeSend` (AC-36/37/38).
 *
 * Failure contract (AC-42): a malformed DSN → one warning naming the setting
 * (never its value) and a no-op reporter; every SDK call is wrapped so neither
 * `capture` nor `flush` can throw into request handling or shutdown.
 *
 * Option names verified against the installed @sentry/node 11.x types:
 * v11 replaced `skipOpenTelemetrySetup` with `enableOpenTelemetrySetup`
 * (default false) and `sendDefaultPii` with the `dataCollection` object.
 */
import * as Sentry from '@sentry/node';
import {
  NoopErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '../../platform/error-reporting.js';
import { scrubEvent } from '../../platform/sentry-scrub.js';

/** Structural logger — pino satisfies it; no framework type crosses in. */
export type ReporterLogger = { warn(msg: string): void };

export type SentryReporterOptions = {
  dsn: string;
  environment: string;
  release: string;
  log: ReporterLogger;
  /** Literal secret values to mask in every event (resolved lazily per event). */
  secrets?: () => ReadonlyArray<string | null | undefined>;
};

/** Bounded in-memory send queue — a black-holed Sentry cannot grow memory. */
const TRANSPORT_BUFFER_SIZE = 30;

/** Shape check only: `http(s)://<publicKey>@<host>/<…/>numericProjectId`. */
export function isValidSentryDsn(dsn: string): boolean {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (!url.username || !url.hostname) return false;
  const last = url.pathname.split('/').filter((s) => s !== '').pop();
  return last !== undefined && /^\d+$/.test(last);
}

class SentryErrorReporter implements ErrorReporter {
  capture(err: unknown, ctx: ReportContext = {}): void {
    try {
      Sentry.withScope((scope) => {
        if (ctx.userId) scope.setUser({ id: ctx.userId });
        if (ctx.route) scope.setTag('route', ctx.route);
        if (ctx.method) scope.setTag('method', ctx.method);
        if (ctx.status !== undefined) scope.setTag('status', String(ctx.status));
        if (ctx.jobKind) scope.setTag('job_kind', ctx.jobKind);
        if (ctx.runId) scope.setTag('run_id', ctx.runId);
        Sentry.captureException(err);
      });
    } catch {
      // fire-and-forget: reporting must never affect the caller (AC-42)
    }
  }

  async flush(timeoutMs: number): Promise<boolean> {
    try {
      return await Sentry.flush(timeoutMs);
    } catch {
      return false;
    }
  }
}

export function createSentryReporter(opts: SentryReporterOptions): ErrorReporter {
  if (!isValidSentryDsn(opts.dsn)) {
    opts.log.warn('SENTRY_DSN is malformed — error reporting disabled');
    return new NoopErrorReporter();
  }
  const secrets = opts.secrets ?? (() => []);

  try {
    Sentry.init({
      dsn: opts.dsn,
      environment: opts.environment,
      release: opts.release,
      // errors only: no tracing/profiling (tracesSampleRate etc. left undefined ⇒ off)
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      defaultIntegrations: false,
      integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
      includeLocalVariables: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
        databaseQueryData: false,
        queues: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        mcp: { inputs: false, outputs: false },
      },
      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,
      beforeSend: (event) => {
        try {
          return scrubEvent(event, secrets());
        } catch {
          return null; // fail closed: an unscrubbable event is never sent
        }
      },
      transportOptions: { bufferSize: TRANSPORT_BUFFER_SIZE },
    });
  } catch {
    opts.log.warn('SENTRY_DSN could not be initialised — error reporting disabled');
    return new NoopErrorReporter();
  }

  return new SentryErrorReporter();
}
