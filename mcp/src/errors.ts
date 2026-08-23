/* errors.ts — CallToolResult factories. `toToolError` is the SINGLE mapper from
   any failure to an `isError: true` result with forward-leading text ("what to
   do next"), per the course principle: errors lead forward, never raw 404s or
   thrown exceptions. Tools catch everything and return through here. */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiError } from './api.js';

/** Resolver failure whose message is already forward-leading — surfaced verbatim. */
export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

export interface ToolErrorContext {
  /** Context-specific next step for HTTP 404s, supplied by the calling tool. */
  notFound?: string;
}

/** Error result with actionable text. */
export function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Success result: structuredContent + mirrored JSON text block. */
export function okResult(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  };
}

const API_DOWN_TEXT = 'DevDigest API is not running — start it with ./scripts/dev.sh';

/** Map any thrown value to an isError tool result. Never throws. */
export function toToolError(err: unknown, ctx?: ToolErrorContext): CallToolResult {
  if (err instanceof ResolveError) return toolError(err.message);

  const message = err instanceof Error ? err.message : String(err);
  const errno = (err as { code?: unknown } | null | undefined)?.code;
  if (errno === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
    return toolError(API_DOWN_TEXT);
  }

  if (err instanceof ApiError) {
    if (err.code === 'timeout') {
      return toolError(
        `The DevDigest API did not respond in time (${err.message}) — retry in a moment.`,
      );
    }
    if (err.status === 0) return toolError(API_DOWN_TEXT);
    if (err.status === 404) {
      return toolError(ctx?.notFound ?? `Not found: ${err.message}. Check the arguments and retry.`);
    }
    if (err.status === 429) {
      return toolError(
        'Rate limited by the DevDigest API (reviews are capped at 10/min) — wait a minute and retry.',
      );
    }
    if (err.status === 400) {
      return toolError(`Invalid request: ${err.message}. Check the arguments and retry with valid values.`);
    }
    return toolError(
      `DevDigest API error ${err.status}: ${err.message}. Retry; if it persists, check the API logs.`,
    );
  }

  return toolError(`Unexpected error: ${message}. Retry; if it persists, check the DevDigest API logs.`);
}

/** Forward-leading "known values" hint for resolver not-found messages. */
export function notFoundHint(kind: string, values: string[]): string {
  return values.length > 0 ? `Known ${kind}: ${values.join(', ')}.` : `No ${kind} configured yet.`;
}
