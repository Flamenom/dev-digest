/**
 * Central route policy — the spec's Permission matrix as ONE table
 * (SPEC-2026-10-19-multi-user-server, AC-28/29/50/52/53/57; plan Rec-1, Q6, Q7).
 *
 * Keyed by `'<METHOD> <fastify route url>'` exactly as the route is registered
 * (`req.routeOptions.url`, e.g. `GET /repos/:id/pulls`). `HEAD` resolves to
 * the `GET` entry. Enforced by `./guard.ts` in google mode only; local mode
 * installs no guard (the system user is Admin, AC-2).
 *
 * Rules:
 *  - **Deny by default (Q7).** A route missing from this table is treated as
 *    `UNCLASSIFIED_POLICY` (Admin, session or token) and the hermetic matrix
 *    test (`test/auth-guard-matrix.test.ts`) FAILS listing it — classify it here.
 *  - **`member` / `admin`** — the minimum role. Admins pass every `member` route.
 *  - **`ownership: 'service'`** — AC-30 "Member own / Admin any" rows. The guard
 *    only checks the base role (`member`); the owning service compares the
 *    actor (`getContext().userId` / `.role`) with the resource's recorded
 *    creator/initiator and throws `ForbiddenOwnerError` (403 `forbidden_owner`).
 *    Legacy rows with no recorded actor are Admin-only.
 *  - **`sessionOnly`** — bearer tokens get 403 `session_required` (AC-57). A
 *    function is a BODY predicate, evaluated in `preHandler` (bodies are not
 *    parsed at `onRequest`).
 *  - **`perIpRateLimit`** — overrides the per-user rate-limit key with the
 *    client IP for this route (sign-in start/callback: 20/min/IP, AC-53).
 *    Applied centrally at route registration (`applyRouteRateLimits`).
 *  - **`audit`** — declarative audit descriptor recorded by `./audit-hook.ts`
 *    on `onSend` when the response status is < 400. Descriptors read ids from
 *    params / the JSON response and key NAMES from the body — never values
 *    (AC-52: no secrets, session ids, tokens or ID tokens in audit metadata).
 *    Events that need data the HTTP edge does not have (sign-in, members,
 *    tokens, rotation, import) or must commit with their write (settings
 *    update, secret save) are recorded by their services instead.
 *
 * Pure data + pure helpers: no Fastify, no I/O.
 */
import type { PrCommentAuditMetadata, SecretKey } from '@devdigest/shared';
import { SECRET_KEY_BY_PROVIDER } from '../secret-keys.js';

export type RouteAccess = 'public' | 'member' | 'admin';

/** What an audit descriptor may read. `response()` parses the JSON body lazily (undefined if not JSON). */
export interface AuditContext {
  params: Readonly<Record<string, unknown>>;
  body: unknown;
  response: () => unknown;
}

export interface AuditDescriptor {
  /** Dotted action name, e.g. `repo.add`, `finding.accept`. */
  action: string;
  targetType: string;
  /** Target id (default: `params.id`). */
  targetId?: (ctx: AuditContext) => string | null;
  /** NAMES and ids only — never a value. */
  metadata?: (ctx: AuditContext) => Record<string, unknown> | undefined;
  /** Record only when this returns true (default: always). */
  when?: (ctx: AuditContext) => boolean;
}

export interface RoutePolicy {
  access: RouteAccess;
  /** `true`, or a predicate over the parsed body (evaluated in `preHandler`). */
  sessionOnly?: true | ((input: { body: unknown }) => boolean);
  /** Public route that still wants `req.principal` when credentials are present (`GET /auth/session`). */
  optionalPrincipal?: true;
  /** AC-30 ownership is enforced by the owning service (see header). Documentary for the guard. */
  ownership?: 'service';
  /** Per-IP limit replacing the per-user key (AC-53). */
  perIpRateLimit?: { max: number; timeWindow: string };
  audit?: AuditDescriptor;
}

/** Q7 — the policy of any route not in {@link ROUTE_POLICY}. */
export const UNCLASSIFIED_POLICY: RoutePolicy = Object.freeze({ access: 'admin' });

// ---- descriptor helpers (pure) ----------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** `id` of the JSON response object (create routes). */
const responseId = (ctx: AuditContext): string | null => {
  const r = ctx.response();
  return r && typeof r === 'object' ? str((r as { id?: unknown }).id) : null;
};

const paramId = (ctx: AuditContext): string | null => str(ctx.params.id);

/**
 * `pr_comment.create` metadata (spec 2026-10-20 AC-42): ids and flags only —
 * read from the created comment (response) and the reply markers of the
 * request body. NEVER the comment body.
 */
export function prCommentAuditMetadata(ctx: AuditContext): PrCommentAuditMetadata | undefined {
  const r = ctx.response();
  if (!r || typeof r !== 'object') return undefined;
  const { id, provider, discussion_id } = r as { id?: unknown; provider?: unknown; discussion_id?: unknown };
  if (typeof id !== 'number' || !Number.isInteger(id)) return undefined;
  const b = (ctx.body && typeof ctx.body === 'object' ? ctx.body : {}) as {
    in_reply_to?: unknown;
    discussion_id?: unknown;
  };
  const discussionId = str(discussion_id);
  return {
    provider: provider === 'gitlab' ? 'gitlab' : 'github',
    host_comment_id: id,
    ...(discussionId ? { discussion_id: discussionId } : {}),
    is_reply: b.in_reply_to != null || b.discussion_id != null,
  };
}

const SIGN_IN_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

/** The managed key NAME a test-connection request saves, or null when it carries no key. */
export function savedSecretKeyName(body: unknown): SecretKey | null {
  if (!body || typeof body !== 'object') return null;
  const { provider, key } = body as { provider?: unknown; key?: unknown };
  if (typeof key !== 'string' || key.length === 0 || typeof provider !== 'string') return null;
  // Own keys only: `provider` is untrusted, and `__proto__` / `constructor` /
  // `toString` would otherwise resolve to Object.prototype members.
  if (!Object.hasOwn(SECRET_KEY_BY_PROVIDER, provider)) return null;
  return (SECRET_KEY_BY_PROVIDER as Record<string, SecretKey>)[provider] ?? null;
}

const audit = (
  action: string,
  targetType: string,
  rest: Omit<AuditDescriptor, 'action' | 'targetType'> = {},
): AuditDescriptor => ({ action, targetType, ...rest });

// ---- the matrix ---------------------------------------------------------------

const PUBLIC: RoutePolicy = { access: 'public' };
const MEMBER: RoutePolicy = { access: 'member' };
const ADMIN: RoutePolicy = { access: 'admin' };

/**
 * Every registered route (plus the identity routes of plan Q6, implemented by
 * the identity module). Grouped like the spec's Permission matrix.
 */
export const ROUTE_POLICY: Readonly<Record<string, RoutePolicy>> = Object.freeze({
  // ── Health + CORS preflight ────────────────────────────────────────────────
  'GET /health': PUBLIC,
  'GET /health/ready': PUBLIC,
  'OPTIONS *': PUBLIC,

  // ── Auth (Q6) ──────────────────────────────────────────────────────────────
  'GET /auth/google/start': { access: 'public', perIpRateLimit: SIGN_IN_LIMIT },
  'GET /auth/google/callback': { access: 'public', perIpRateLimit: SIGN_IN_LIMIT },
  'GET /auth/session': { access: 'public', optionalPrincipal: true },
  'POST /auth/sign-out': { access: 'member', sessionOnly: true },

  // ── Members ────────────────────────────────────────────────────────────────
  'GET /members': MEMBER,
  'PATCH /members/:userId': { access: 'admin', sessionOnly: true },

  // ── Personal tokens (own; Admin may revoke anyone's — checked in TokensService) ──
  'GET /tokens': { access: 'member', sessionOnly: true },
  'POST /tokens': { access: 'member', sessionOnly: true },
  'DELETE /tokens/:id': { access: 'member', sessionOnly: true, ownership: 'service' },

  // ── Repos ──────────────────────────────────────────────────────────────────
  'GET /repos': MEMBER,
  'GET /workspace': MEMBER,
  'POST /repos': { access: 'admin', audit: audit('repo.add', 'repo', { targetId: responseId }) },
  'DELETE /repos/:id': { access: 'admin', audit: audit('repo.remove', 'repo') },
  'POST /repos/:id/refresh': MEMBER,
  'POST /repos/:id/resync': MEMBER,
  'GET /repos/:id/index-state': MEMBER,

  // ── PR list (+ SSE) ────────────────────────────────────────────────────────
  'GET /repos/:id/pulls': MEMBER,
  'GET /repos/:id/pulls/page': MEMBER,
  'POST /repos/:id/pulls/sync': MEMBER,
  'POST /repos/:id/poll': MEMBER,
  'GET /repos/:id/pulls/sync/events': MEMBER,

  // ── PR detail + actions ────────────────────────────────────────────────────
  'GET /pulls/:id': MEMBER,
  'GET /pulls/:id/comments': MEMBER,
  'GET /pulls/:id/smart-diff': MEMBER,
  'GET /pulls/:id/blast': MEMBER,
  'GET /pulls/:id/intent': MEMBER,
  'GET /pulls/:id/brief': MEMBER,
  // AC-41: Members and Admins may post/reply. AC-42: one row per successful
  // post (hook: status < 400 + principal ⇒ google mode only, never on failure).
  // NOTE: this route uses `attachValidation: true` (modules/pulls/routes.ts), so
  // the preHandler runs on an UNVALIDATED body. Never add a body-dependent
  // predicate (e.g. `sessionOnly`) here without moving validation back first.
  'POST /pulls/:id/comments': {
    access: 'member',
    audit: audit('pr_comment.create', 'pull_request', { metadata: prCommentAuditMetadata }),
  },
  'POST /pulls/:id/intent': MEMBER,
  'POST /pulls/:id/brief': MEMBER,

  // ── Reviews & runs (+ SSE) ─────────────────────────────────────────────────
  'POST /pulls/:id/review': MEMBER,
  'GET /pulls/:id/runs': MEMBER,
  'GET /pulls/:id/runs/active': MEMBER,
  'GET /pulls/:id/reviews': MEMBER,
  'GET /runs/:id/trace': MEMBER,
  'GET /runs/:id/events': MEMBER,
  'POST /runs/:id/cancel': { access: 'member', ownership: 'service' },
  'DELETE /runs/:id': { access: 'admin', audit: audit('run.delete', 'run') },
  'DELETE /reviews/:id': { access: 'admin', audit: audit('review.delete', 'review') },

  // ── Findings (Q10: audited) ────────────────────────────────────────────────
  'POST /findings/:id/accept': { access: 'member', audit: audit('finding.accept', 'finding') },
  'POST /findings/:id/dismiss': { access: 'member', audit: audit('finding.dismiss', 'finding') },

  // ── Eval cases ─────────────────────────────────────────────────────────────
  'POST /findings/:id/eval-case': MEMBER,
  'GET /findings/:id/eval-case-draft': MEMBER,
  'POST /eval-cases': MEMBER,
  'GET /pulls/:id/eval-cases': MEMBER,
  'GET /agents/:id/eval-cases': MEMBER,
  'GET /eval-cases/:id': MEMBER,
  'GET /evals/batches/:batchId': MEMBER,
  'GET /agents/:id/eval-batches': MEMBER,
  'GET /agents/:id/eval-runs': MEMBER,
  'GET /agents/:id/eval-dashboard': MEMBER,
  'GET /evals/dashboard': MEMBER,
  'GET /evals/compare': MEMBER,
  'PUT /eval-cases/:id': { access: 'member', ownership: 'service' },
  'DELETE /eval-cases/:id': { access: 'member', ownership: 'service' },

  // ── Eval runs ──────────────────────────────────────────────────────────────
  'POST /eval-cases/:id/run': MEMBER,
  'POST /agents/:id/eval-cases/run-draft': MEMBER,
  'POST /agents/:id/eval-runs': MEMBER,
  'POST /evals/run-all': MEMBER,

  // ── Agents ─────────────────────────────────────────────────────────────────
  'GET /agents': MEMBER,
  'GET /agents/:id': MEMBER,
  'GET /agents/:id/versions': MEMBER,
  'GET /agents/:id/versions/:version': MEMBER,
  'GET /agents/:id/skills': MEMBER,
  'GET /agents/:id/models': MEMBER,
  'GET /providers/:id/models': MEMBER,
  'POST /agents': { access: 'admin', audit: audit('agent.create', 'agent', { targetId: responseId }) },
  'PUT /agents/:id': { access: 'admin', audit: audit('agent.update', 'agent') },
  'DELETE /agents/:id': { access: 'admin', audit: audit('agent.delete', 'agent') },
  'POST /agents/:id/versions/:version/promote': {
    access: 'admin',
    audit: audit('agent.promote', 'agent', {
      metadata: (ctx) => ({ version: ctx.params.version }),
    }),
  },
  'POST /agents/:id/skills': { access: 'admin', audit: audit('agent.skills_update', 'agent') },
  'PUT /agents/:id/attached-docs': { access: 'admin', audit: audit('agent.docs_update', 'agent') },

  // ── Skills ─────────────────────────────────────────────────────────────────
  'GET /skills': MEMBER,
  'GET /skills/usage': MEMBER,
  'GET /skills/:id': MEMBER,
  'GET /skills/:id/stats': MEMBER,
  'GET /skills/:id/versions': MEMBER,
  'GET /skills/:id/versions/:v': MEMBER,
  'POST /skills': { access: 'admin', audit: audit('skill.create', 'skill', { targetId: responseId }) },
  'POST /skills/import': {
    access: 'admin',
    audit: audit('skill.import', 'skill', { targetId: responseId }),
  },
  'PUT /skills/:id': { access: 'admin', audit: audit('skill.update', 'skill') },
  'PUT /skills/:id/attached-docs': { access: 'admin', audit: audit('skill.docs_update', 'skill') },
  'DELETE /skills/:id': { access: 'admin', audit: audit('skill.delete', 'skill') },
  'POST /skills/:id/restore': { access: 'admin', audit: audit('skill.restore', 'skill') },

  // ── Conventions ────────────────────────────────────────────────────────────
  'GET /repos/:id/conventions': MEMBER,
  'POST /repos/:id/conventions/extract': ADMIN,
  'PATCH /repos/:id/conventions': ADMIN,
  'PATCH /conventions/:id': ADMIN,

  // ── Project context ────────────────────────────────────────────────────────
  'GET /repos/:repoId/project-context': MEMBER,
  'GET /repos/:repoId/project-context/document': MEMBER,
  'PUT /repos/:repoId/project-context/document': ADMIN,

  // ── Settings + secrets ─────────────────────────────────────────────────────
  'GET /settings': MEMBER,
  'GET /settings/secrets-status': MEMBER,
  // `settings.update` / `secret.save` are audited by SettingsService inside the
  // write's own transaction (durable, and tied to the write — not to the HTTP
  // status), so these entries carry NO `audit` descriptor: nothing is double-written.
  'PUT /settings': ADMIN,
  'POST /settings/test-connection': {
    access: 'admin',
    // AC-57: saving a key is a secret write → interactive session only.
    sessionOnly: ({ body }) => savedSecretKeyName(body) !== null,
  },
});

/** `'<METHOD> <url>'`; HEAD shares the GET entry. */
export function policyKey(method: string, url: string): string {
  const m = method.toUpperCase();
  return `${m === 'HEAD' ? 'GET' : m} ${url}`;
}

export interface PolicyLookup {
  key: string;
  policy: RoutePolicy;
  /** False → not in the table; `policy` is {@link UNCLASSIFIED_POLICY}. */
  classified: boolean;
}

export function lookupPolicy(method: string, url: string): PolicyLookup {
  const key = policyKey(method, url);
  const policy = Object.prototype.hasOwnProperty.call(ROUTE_POLICY, key) ? ROUTE_POLICY[key] : undefined;
  return policy
    ? { key, policy, classified: true }
    : { key, policy: UNCLASSIFIED_POLICY, classified: false };
}

/** Registered routes (as `policyKey`s) missing from the table — the matrix test asserts this is empty. */
export function unclassifiedRoutes(keys: Iterable<string>): string[] {
  return [...new Set(keys)].filter((k) => !Object.prototype.hasOwnProperty.call(ROUTE_POLICY, k)).sort();
}
