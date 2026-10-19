/**
 * Typed readers for `catch (err: unknown)` values. They only touch `.name` /
 * `.message` / `.code` on a real `Error`, so a thrown string / object / null
 * never crashes a log line and never smuggles an arbitrary payload into it.
 *
 * For logs that must carry no data (auth, audit, OAuth callbacks) prefer
 * {@link describeError} — the error CLASS and driver code (e.g. a Postgres
 * SQLSTATE), never the message, which can echo SQL values or URLs.
 */

/** The error's class name for an `Error`, else the `typeof` of the thrown value. */
export function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/** The message for an `Error`, else `undefined` — never stringifies arbitrary values. */
export function errorMessage(e: unknown): string | undefined {
  return e instanceof Error ? e.message : undefined;
}

/** A string `code` own/inherited property of an `Error` (node / driver codes), else `undefined`. */
export function errorCode(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const code = (e as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Data-free log fields for a caught value: `{ errName, errCode? }`. */
export function describeError(e: unknown): { errName: string; errCode?: string } {
  const errCode = errorCode(e);
  return errCode === undefined ? { errName: errorName(e) } : { errName: errorName(e), errCode };
}
