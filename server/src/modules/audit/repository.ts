/**
 * Audit repository — the append-only `audit_events` trail (AC-52).
 *
 * Insert-only by design: there is no update/delete method, and migration 0021's
 * BEFORE UPDATE OR DELETE trigger raises if anything tries. `metadata` is passed
 * through {@link scrubMetadata} at this boundary so a careless caller cannot
 * persist a secret value, token, cookie, password, authorization code or ID token.
 * Row contents are never logged.
 */
import { isIP } from 'node:net';
import type { AuditEventInput, AuditLog } from '../../vendor/shared/auth-ports.js';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/** The handle Drizzle passes to a `db.transaction(async (tx) => …)` callback. */
export type AuditTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Key segments that mark a field as sensitive wherever they appear in the name. */
const SENSITIVE_ANYWHERE = new Set(['secret', 'secrets', 'password', 'passwd', 'cookie', 'cookies']);
/** Key segments that mark a field as sensitive when they END the name (`api_token`, `auth_code`). */
const SENSITIVE_LAST = new Set(['value', 'token', 'code']);
/** Nesting beyond this depth is replaced by a marker (metadata is meant to be flat). */
const MAX_DEPTH = 8;

/** Split `idToken` / `id_token` / `id-token` into lowercase segments. */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when a metadata key names a value that must never be audited. */
export function isSensitiveMetadataKey(key: string): boolean {
  const segs = keySegments(key);
  if (segs.length === 0) return false;
  if (segs.some((s) => SENSITIVE_ANYWHERE.has(s))) return true;
  const last = segs[segs.length - 1]!;
  if (SENSITIVE_LAST.has(last)) return true;
  // `id_token` in any position (e.g. `id_token_hint`).
  return segs.some((s, i) => s === 'id' && segs[i + 1] === 'token');
}

function scrubValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  // Binary payloads (ciphertext, nonces, keys) never belong in an audit row.
  if (value instanceof Uint8Array) return undefined;
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveMetadataKey(k)) continue;
    const scrubbed = scrubValue(v, depth + 1);
    if (scrubbed !== undefined) out[k] = scrubbed;
  }
  return out;
}

/**
 * Drop every key (recursively) whose name is like
 * `value|token|secret|cookie|password|code|id_token` — e.g. `value`, `api_token`,
 * `clientSecret`, `session_cookie`, `auth_code`, `idToken`. Identifiers such as
 * `token_id`, `token_name` and `key_name` are kept (the sensitive word does not end
 * the name). Binary values are dropped. Returns a new object; the input is untouched.
 */
export function scrubMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  return scrubValue(metadata, 0) as Record<string, unknown>;
}

/**
 * `audit_events.ip` is `inet`: keep only a valid IPv4/IPv6 literal, otherwise null,
 * so a malformed `X-Forwarded-For` or proxy value can never fail the audit insert.
 */
export function normalizeAuditIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  // Node accepts IPv6 zone ids (`fe80::1%eth0`); Postgres `inet` does not.
  if (trimmed.includes('%')) return null;
  return isIP(trimmed) !== 0 ? trimmed : null;
}

export class AuditRepository implements AuditLog<AuditTx> {
  constructor(private db: Db) {}

  private exec(tx?: AuditTx): Db {
    // A transaction exposes the same builders as the client; the cast avoids a
    // `Db | PgTransaction` union TypeScript can't resolve overloads across.
    return (tx ?? this.db) as Db;
  }

  /** Append one event. Joins the caller's transaction when `tx` is given. */
  record = async (event: AuditEventInput, tx?: AuditTx): Promise<void> => {
    await this.exec(tx)
      .insert(t.auditEvents)
      .values({
        workspaceId: event.workspaceId,
        actorUserId: event.actorUserId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId ?? null,
        metadata: scrubMetadata(event.metadata),
        ip: normalizeAuditIp(event.ip),
      });
  };
}
