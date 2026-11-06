/**
 * Error-reporting helpers for the `ErrorReporter` port (declared in
 * `vendor/shared/error-reporter.ts`; structural, like `JobLogger` / `SyncLogger`): the
 * composition root builds ONE reporter — the Sentry adapter when a DSN is
 * configured, else `NoopErrorReporter` — and hands it to the HTTP error
 * handler, the process handlers and the background runners.
 *
 * Contract: fire-and-forget. `capture` and `flush` NEVER throw and never block
 * request handling (AC-42). Only internal failures are reported (`isReportable`,
 * AC-34): expected application errors (< 500), upstream-provider failures and
 * user cancellations are not.
 *
 * No vendor import here — `@sentry/node` lives only in `adapters/sentry/`.
 */
import type { ErrorReporter, ReportContext } from '../vendor/shared/error-reporter.js';
import { AppError, ExternalServiceError } from './errors.js';

// The port itself lives in the vendored shared contracts; re-exported so
// existing importers keep a single import site for port + helpers.
export type { ErrorReporter, ReportContext };

/** The inactive reporter: no SDK, no connection, no behaviour change (AC-32). */
export class NoopErrorReporter implements ErrorReporter {
  capture(_err: unknown, _ctx?: ReportContext): void {
    // intentionally empty
  }

  async flush(_timeoutMs: number): Promise<boolean> {
    return true;
  }
}

/**
 * Name of the review-run cancellation error (`modules/reviews/run-executor.ts`).
 * Matched by name SHAPE so the platform ring does not import a feature module.
 */
const RUN_CANCELLED_ERROR_NAME = 'RunCancelledError';

function numericField(obj: object, key: 'status' | 'statusCode'): number | undefined {
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * True when `err` is an INTERNAL failure worth reporting (Rec3 / AC-34).
 *
 * Not reportable:
 *  - a user cancellation (`RunCancelledError`, by name);
 *  - `AppError` with `statusCode < 500` (validation, not-found, conflict, …);
 *  - `ExternalServiceError` (502 — the upstream host failed, not us);
 *  - a provider-SDK error: an object carrying a numeric `status`/`statusCode`
 *    together with `headers` (OpenAI / Octokit / GitLab-http shape), whatever
 *    the status — the provider reports its own outages;
 *  - any other error carrying a numeric `status`/`statusCode` below 500
 *    (e.g. Fastify validation / client errors).
 *
 * Everything else (plain `Error`, `AppError` ≥ 500 incl. `ConfigError`, non-Error
 * throwables) is reportable.
 */
export function isReportable(err: unknown): boolean {
  if (err === null || err === undefined) return true;
  if (typeof err !== 'object') return true;

  if ((err as { name?: unknown }).name === RUN_CANCELLED_ERROR_NAME) return false;
  if (err instanceof ExternalServiceError) return false;
  if (err instanceof AppError) return err.statusCode >= 500;

  const status = numericField(err, 'status') ?? numericField(err, 'statusCode');
  if (status === undefined) return true;
  if ('headers' in err) return false; // provider SDK error shape
  return status >= 500;
}
