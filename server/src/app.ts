import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import {
  validatorCompiler,
  serializerCompiler,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadConfig, type AppConfig } from './platform/config.js';
import { createDb, type Db } from './db/client.js';
import { Container, type ContainerOverrides } from './platform/container.js';
import { AppError } from './platform/errors.js';
import { modules } from './modules/index.js';
import { claimInstance, type InstanceClaim } from './db/instance-claim.js';
import {
  DEFAULT_REJECTION_LIMIT,
  installAuthGuard,
  installRoutePolicyHooks,
  rateLimitKey,
} from './platform/auth/guard.js';
import { installAuditHook } from './platform/auth/audit-hook.js';
import { decorateRequestPrincipal } from './platform/auth/request-principal.js';
import { ReviewService } from './modules/reviews/service.js';
import { ZIP_MAX_BYTES } from './modules/skills/constants.js';
import { SESSION_COOKIE } from './modules/identity/constants.js';

// Attach the DI container to every request/instance.
declare module 'fastify' {
  interface FastifyInstance {
    container: Container;
  }
}

export interface BuildAppOptions {
  config?: AppConfig;
  db?: Db;
  overrides?: ContainerOverrides;
  /**
   * google mode only: run the boot sequence (instance claim → secrets
   * maintenance → no-admin warning). Default true; hermetic tests pass false
   * (no Postgres needed). Stale-run reaping runs either way, as before.
   */
  bootChecks?: boolean;
  /**
   * Force the global rate limiter on/off. Default: on unless NODE_ENV=test
   * (unchanged). Tests set `true` to exercise AC-53.
   */
  rateLimit?: boolean;
  /**
   * Tests: send the JSON log lines to this stream (at `info` unless the config
   * level is set) so boot warnings and redaction can be asserted.
   */
  logStream?: { write: (line: string) => void };
}

/** Response headers never written to logs (NFR logging). */
const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * `code=` / `state=` query parameters (case-insensitive) — the OAuth callback
 * values that must never reach a log line. Matches the value up to the next
 * `&` or `#`.
 */
const REDACTED_QUERY_PARAM_RE = /([?&](?:code|state)=)[^&#]*/gi;

/**
 * The request URL as logged: `code` / `state` query values replaced with
 * `[REDACTED]` on every route (the OAuth callback carries them; an error log
 * line for any request includes the URL). Exported for tests.
 */
export function redactLogUrl(url: string): string {
  if (!url.includes('?')) return url;
  // In-place replace: every other byte of the URL stays exactly as received.
  // The marker is percent-encoded so the logged URL stays a valid query string.
  return url.replace(REDACTED_QUERY_PARAM_RE, '$1%5BREDACTED%5D');
}

/** Fastify's default `req` serializer, with the URL passed through {@link redactLogUrl}. */
const LOG_SERIALIZERS = {
  req: (req: {
    method?: string;
    url?: string;
    version?: string;
    host?: string;
    hostname?: string;
    ip?: string;
    socket?: { remotePort?: number };
  }) => ({
    method: req.method,
    url: typeof req.url === 'string' ? redactLogUrl(req.url) : req.url,
    version: req.version,
    host: req.host ?? req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  }),
};

/** Strict-Transport-Security in google mode (AC-62): one year, subdomains. */
const HSTS = { maxAge: 31_536_000, includeSubDomains: true } as const;

type BootLogger = Pick<FastifyInstance['log'], 'info' | 'warn' | 'error'>;

/**
 * google-mode boot (AC-5, AC-19, AC-39, AC-41, AC-42), after the instance
 * claim: secrets maintenance, then the no-admin warning. Messages carry key
 * NAMES only (the maintenance service owns their wording).
 */
async function googleBootChecks(container: Container, log: BootLogger): Promise<void> {
  const maintenance = container.secretsMaintenance({
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
  });
  await maintenance.rotateIfNeeded();
  await maintenance.reportUndecryptable();
  maintenance.warnIgnoredEnv();

  // AC-19: the seeded system user cannot sign in in google mode, so it does
  // not count as an Admin a person could act as.
  const [workspaceId, system] = await Promise.all([
    container.teamWorkspaceId(),
    container.auth.currentUser({}),
  ]);
  const members = await container.identityRepo.memberships.list(workspaceId);
  const hasAdmin = members.some(
    (m) => m.role === 'admin' && m.status === 'active' && m.userId !== system.id,
  );
  if (!hasAdmin && container.config.adminEmails.length === 0) {
    log.warn(
      'No admin — the workspace has no active Admin and AUTH_ADMIN_EMAILS is empty. ' +
        'Set the admin allowlist and sign in; until then everyone signs in as Member.',
    );
  }
}

/**
 * buildApp() — exported so tests can use `app.inject()` without a real port.
 * Wires the zod type provider (request validation + response serialization),
 * the security/transport plugins (helmet, cors, rate-limit, SSE) ahead of the
 * DI container and the statically-registered feature modules, plus a structured
 * error handler returning the ApiErrorBody envelope.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const handle = opts.db ? null : createDb(config.databaseUrl);
  const db = opts.db ?? handle!.db;

  const google = config.authMode === 'google';
  const bootChecks = opts.bootChecks ?? true;

  // AC-5: one API process per database in google mode. Taken first so a
  // second instance refuses to start before touching anything else.
  let claim: InstanceClaim | null = null;
  // Until the app exists its onClose hooks can't release the claim / handle,
  // so a throw anywhere between the claim and those hooks is cleaned up here.
  let app: FastifyInstance;
  let container: Container;
  try {
    if (google && bootChecks) claim = await claimInstance(config.databaseUrl);
    app = createFastify(config, opts);
    container = new Container(config, db, opts.overrides, app.log);
    app.decorate('container', container);

    // Release the instance claim + our db handle on shutdown (and on a failed boot).
    const ownedClaim = claim;
    if (ownedClaim) app.addHook('onClose', async () => ownedClaim.release());
    if (handle) app.addHook('onClose', async () => handle.close());
  } catch (err) {
    await claim?.release().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    throw err;
  }

  try {
    await configureApp(app, container, db, config, opts);
  } catch (err) {
    // The onClose hooks above release the claim + handle exactly once.
    await app.close().catch(() => undefined);
    throw err;
  }
  return app;
}

function createFastify(config: AppConfig, opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    // Explicit 1MB cap on request bodies (PR comments, settings payloads are
    // small). Protects against oversized/abusive payloads.
    bodyLimit: 1_048_576,
    // AC-66 / Q9: trust X-Forwarded-* only from the configured proxy (default: nobody).
    trustProxy: config.trustProxy,
    logger: opts.logStream
      ? {
          level: config.logLevel === 'silent' ? 'info' : config.logLevel,
          redact: REDACTED_LOG_PATHS,
          serializers: LOG_SERIALIZERS,
          stream: opts.logStream,
        }
      : config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: REDACTED_LOG_PATHS,
            serializers: LOG_SERIALIZERS,
            transport:
              config.nodeEnv === 'development'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
          },
  });

  // Use zod schemas directly for request validation + response serialization.
  // Routes opt in per-module via `app.withTypeProvider<ZodTypeProvider>()`.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

async function configureApp(
  app: FastifyInstance,
  container: Container,
  db: Db,
  config: AppConfig,
  opts: BuildAppOptions,
): Promise<void> {
  const google = config.authMode === 'google';

  if (google && (opts.bootChecks ?? true)) await googleBootChecks(container, app.log);
  if (!google && config.nodeEnv === 'production' && config.allowUnauthenticatedLocal) {
    // AC-4: acknowledged, but loud.
    app.log.warn(
      'AUTH_MODE=local with NODE_ENV=production: the API is UNAUTHENTICATED — every request acts ' +
        'as the local Admin (ALLOW_UNAUTHENTICATED_LOCAL_MODE=true). Use AUTH_MODE=google for a shared deployment.',
    );
  }

  // Reap runs left 'running' by a previous (now-dead) process — otherwise they
  // show as perpetually "running" in the UI and can't be cancelled (no runner).
  //
  // AWAITED before the server accepts requests: a fresh process has no in-flight
  // runs of its own yet (runs only start via POST /review once listening), so
  // every 'running' row here is genuinely orphaned. Awaiting also closes the
  // race where a brand-new run could be created (and wrongly reaped) in the gap
  // between listening and an async reaper finishing.
  // NOTE: assumes a SINGLE API instance per DB. With multiple replicas this
  // would need per-instance scoping / heartbeats (not this app's deployment).
  try {
    const reaped = await new ReviewService(container).reapStaleRuns();
    if (reaped > 0) app.log.info({ reaped }, 'reaped stale running agent_runs on boot');
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'stale-run reaping failed (non-fatal)');
  }

  // Route bookkeeping + per-IP sign-in limits — before rate-limit and modules.
  installRoutePolicyHooks(app);
  decorateRequestPrincipal(app);

  // Security headers (X-Content-Type-Options, X-Frame-Options, …). The API
  // serves JSON only, so the default CSP is fine. google mode pins HSTS (AC-62).
  await app.register(helmet, google ? { hsts: HSTS } : {});
  // CORS: credentialed requests only from the web origin — in google mode the
  // public origin and nothing else (AC-51). Registered before the guard so
  // 401/403 answers still carry the CORS headers the browser needs to read them.
  await app.register(cors, { origin: [config.webOrigin], credentials: true });
  // Session / OAuth-binding cookies (identity routes).
  await app.register(cookie);

  // google mode: deny by default (AC-28). Root hooks added BEFORE rate-limit
  // and the modules, so they run first for every route.
  const rateLimitOn = opts.rateLimit ?? config.nodeEnv !== 'test';
  if (google) {
    installAuthGuard(app, {
      principals: () => container.principals,
      publicOrigin: config.publicOrigin ?? config.webOrigin,
      sessionCookie: SESSION_COOKIE,
      // Rejected requests never reach the route-level limiter below — the
      // guard charges them per IP itself.
      rejectionLimit: rateLimitOn ? DEFAULT_REJECTION_LIMIT : null,
    });
    installAuditHook(app, { audit: () => container.audit });
  }
  // L02 — skill-import uploads (POST /skills/import: one .md/.zip file). Hard
  // transport cap of 2 MB / 1 file; the import parser re-enforces the
  // format-specific limits (md ≤ 256 KB, SKILL.md entry ≤ 256 KB uncompressed).
  await app.register(multipart, { limits: { files: 1, fileSize: ZIP_MAX_BYTES } });
  await app.register(FastifySSEPlugin);

  // Global rate limit. Disabled under test so integration suites can hammer
  // endpoints via inject(); per-route overrides live on the routes themselves.
  // Keyed per user when authenticated, per IP otherwise (AC-53).
  if (rateLimitOn) {
    await app.register(rateLimit, { max: 120, timeWindow: '1 minute', keyGenerator: rateLimitKey });
  }

  // Liveness check (no module, no DB, no rate limit).
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  // Readiness check — verifies the DB is reachable with a cheap `SELECT 1`.
  // 503 (not 500) so orchestrators treat it as "not ready yet", not a crash.
  app.get('/health/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ready: true };
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'readiness check failed: db unreachable');
      return reply.status(503).send({ ready: false });
    }
  });

  // Structured error handler. Registered BEFORE modules so encapsulated
  // module plugins inherit it. Validation → 422; AppError → its status.
  app.setErrorHandler((err: unknown, _req, reply) => {
    // Request validation failure from the zod type provider (schema.body/params).
    if (hasZodFastifySchemaValidationErrors(err)) {
      reply.status(422).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: err.validation,
        },
      });
      return;
    }
    // Response failed its own serialization schema — never leak the raw object;
    // log it and return a generic 500.
    if (isResponseSerializationError(err)) {
      app.log.error({ err }, 'response serialization failed');
      reply.status(500).send({ error: { code: 'internal_error', message: 'Internal error' } });
      return;
    }
    // Robust ZodError detection: `instanceof` can fail across duplicate zod
    // module instances (shared vs api), so also match by shape. Still needed for
    // service-level `.parse` calls and routes not yet on schema.body.
    const maybeZod = err as { name?: string; issues?: unknown; errors?: unknown };
    const isZodError =
      err instanceof z.ZodError ||
      (maybeZod?.name === 'ZodError' &&
        (Array.isArray(maybeZod.issues) || Array.isArray(maybeZod.errors)));
    if (isZodError) {
      reply.status(422).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: maybeZod.issues ?? maybeZod.errors,
        },
      });
      return;
    }
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    reply.status(e.statusCode ?? 500).send({
      error: { code: 'internal_error', message: e.message ?? 'Internal error' },
    });
  });

  // Register feature modules from the static registry (src/modules/index.ts).
  // Each module is a Fastify plugin in modules/<name>/routes.ts.
  for (const plugin of Object.values(modules)) {
    await app.register(plugin);
  }
}
