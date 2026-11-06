/**
 * Error-reporting port. The composition root builds ONE reporter (a vendor
 * adapter when configured, else a no-op) and hands it to the HTTP error
 * handler, the process handlers and the background runners.
 *
 * Contract: fire-and-forget. `capture` and `flush` NEVER throw and never block
 * request handling. No vendor types here.
 */

/** Low-cardinality, non-sensitive context attached to a captured error. */
export type ReportContext = {
  /** Internal user id only — never email/name/IP. */
  userId?: string;
  /** Route TEMPLATE (e.g. `/pulls/:id/review`), never the raw URL. */
  route?: string;
  method?: string;
  status?: number;
  /** Background job kind (clone, index, review, publish, …). */
  jobKind?: string;
  runId?: string;
};

export interface ErrorReporter {
  /** Report one error. Must not throw. */
  capture(err: unknown, ctx?: ReportContext): void;
  /** Drain pending events for at most `timeoutMs`. Resolves (never rejects). */
  flush(timeoutMs: number): Promise<boolean>;
}
