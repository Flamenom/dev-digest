/**
 * Route-driven audit events (AC-52, Q10). One root `onSend` hook records the
 * declarative descriptor of the matched route's policy entry
 * (`route-policy.ts → audit`) when:
 *   - a principal was resolved for the request (google mode — local mode has
 *     no guard and records nothing here, preserving AC-2), and
 *   - the response status is < 400 (the action actually happened).
 *
 * The descriptor reads ids from params / the JSON response and key NAMES from
 * the body; the hook never copies headers, cookies or body values into the
 * event. An audit write failure is logged and does not fail the response —
 * the mutation has already been committed.
 */
import type { FastifyInstance } from 'fastify';
import type { AuditEventInput } from '@devdigest/shared';
import { lookupPolicy, type AuditContext } from './route-policy.js';

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

export function installAuditHook(app: FastifyInstance, deps: AuditHookDeps): void {
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

    try {
      if (descriptor.when && !descriptor.when(ctx)) return payload;
      const fallbackId = typeof ctx.params.id === 'string' ? ctx.params.id : null;
      await deps.audit().record({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        action: descriptor.action,
        targetType: descriptor.targetType,
        targetId: descriptor.targetId ? descriptor.targetId(ctx) : fallbackId,
        metadata: descriptor.metadata?.(ctx),
        ip: req.ip ?? null,
      });
    } catch (err) {
      req.log.error(
        { action: descriptor.action, err: (err as Error)?.message },
        'audit event could not be recorded',
      );
    }
    return payload;
  });
}
