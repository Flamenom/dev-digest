/**
 * Route-driven audit events (AC-52, Q10). A root `onSend` hook builds the
 * event from the matched route's declarative descriptor (`route-policy.ts →
 * audit`) and STARTS the write right there as a fire-and-forget promise —
 * never awaited on the response path, so it doesn't delay the client, and not
 * tied to `onResponse`, which Fastify skips when the client aborts (a committed
 * mutation must still get its row). Recorded when:
 *   - a principal was resolved for the request (google mode — local mode has
 *     no guard and records nothing here, preserving AC-2), and
 *   - the response status is < 400 (the action actually happened).
 *
 * The descriptor reads ids from params / the JSON response and key NAMES from
 * the body; the hook never copies headers, cookies or body values into the
 * event. An audit write failure is logged and does not fail the response —
 * the mutation has already been committed.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditEventInput } from '@devdigest/shared';
import { lookupPolicy, type AuditContext } from './route-policy.js';
import { describeError } from '../errors-describe.js';

/**
 * In-flight audit writes above this count signal a stalled audit store. We
 * warn (once per burst — re-armed when the set drains below the threshold)
 * but never drop events: every committed mutation still gets its row.
 */
export const AUDIT_IN_FLIGHT_WARN_THRESHOLD = 1000;

function parseJson(payload: unknown): unknown {
  const text =
    typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null;
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface AuditHookDeps {
  /** Resolved lazily (container getter). Records outside any transaction. */
  audit: () => { record: (event: AuditEventInput) => Promise<void> };
}

/** In-flight writes per app — awaited on close and by {@link auditWritesSettled}. */
const inFlight = new WeakMap<FastifyInstance, Set<Promise<void>>>();

/**
 * Resolves once every audit write has finished (success or logged failure) —
 * including writes started WHILE draining (a response still in `onSend` during
 * shutdown): the set is re-checked until it is empty, not snapshotted once.
 * Writes are registered synchronously in `onSend`, i.e. before the response is
 * delivered, so a caller that awaits this right after a request (`inject`)
 * always sees that request's row.
 */
export async function auditWritesSettled(app: FastifyInstance): Promise<void> {
  const writes = inFlight.get(app);
  if (!writes) return;
  while (writes.size > 0) await Promise.allSettled([...writes]);
}

export function installAuditHook(app: FastifyInstance, deps: AuditHookDeps): void {
  const writes = new Set<Promise<void>>();
  inFlight.set(app, writes);
  let burstWarned = false;

  /** Start the write and track it; a failure is logged, never surfaced (the mutation is committed). */
  const startWrite = (req: FastifyRequest, action: string, event: AuditEventInput): void => {
    const write = (async () => {
      try {
        await deps.audit().record(event);
      } catch (err) {
        req.log.error({ action, ...describeError(err) }, 'audit event could not be recorded');
      }
    })();
    writes.add(write);
    if (writes.size > AUDIT_IN_FLIGHT_WARN_THRESHOLD && !burstWarned) {
      burstWarned = true;
      req.log.warn(
        { inFlight: writes.size, threshold: AUDIT_IN_FLIGHT_WARN_THRESHOLD },
        'audit writes are backing up (none dropped)',
      );
    }
    void write.finally(() => {
      writes.delete(write);
      if (writes.size <= AUDIT_IN_FLIGHT_WARN_THRESHOLD) burstWarned = false;
    });
  };

  // Build the event while the payload is at hand and start the write — not
  // awaited, so the response is never held up by it.
  app.addHook('onSend', async (req, reply, payload) => {
    const principal = req.principal;
    if (!principal || reply.statusCode >= 400) return payload;
    const url = req.routeOptions.url;
    if (url === undefined) return payload;
    const descriptor = lookupPolicy(req.method, url).policy.audit;
    if (!descriptor) return payload;

    let parsed: { done: boolean; value: unknown } = { done: false, value: undefined };
    const ctx: AuditContext = {
      params: (req.params ?? {}) as Record<string, unknown>,
      body: req.body,
      response: () => {
        if (!parsed.done) parsed = { done: true, value: parseJson(payload) };
        return parsed.value;
      },
    };

    let event: AuditEventInput;
    try {
      if (descriptor.when && !descriptor.when(ctx)) return payload;
      const fallbackId = typeof ctx.params.id === 'string' ? ctx.params.id : null;
      event = {
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        action: descriptor.action,
        targetType: descriptor.targetType,
        targetId: descriptor.targetId ? descriptor.targetId(ctx) : fallbackId,
        metadata: descriptor.metadata?.(ctx),
        ip: req.ip ?? null,
      };
    } catch (err) {
      req.log.error(
        { action: descriptor.action, ...describeError(err) },
        'audit event could not be recorded',
      );
      return payload;
    }
    startWrite(req, descriptor.action, event);
    return payload;
  });

  // Graceful shutdown: let in-flight audit writes finish before the DB closes.
  app.addHook('onClose', async () => {
    await auditWritesSettled(app);
  });
}
