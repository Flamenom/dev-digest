import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrDetailHost, PrMetaHost, PrSyncDoneEvent } from '@devdigest/shared';
import { HostComment, HostCommentInput, PrListPage, PrSyncStartResult } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { AppError, NotFoundError } from '../../platform/errors.js';
import type { PersistedRepo } from './repository.js';

/**
 * F1 — pulls module. PR list (persisted, synced on open) + per-PR detail.
 *   GET  /repos/:id/pulls             → persisted PR list (bare array — MCP
 *                                        relies on it); triggers sync-on-open
 *   GET  /repos/:id/pulls/page        → { pulls, sync } for the UI
 *   POST /repos/:id/pulls/sync        → manual list sync → { trigger }
 *   GET  /repos/:id/pulls/sync/events → SSE: ONE `done` event, then close
 *   GET  /pulls/:id                   → full PR detail (diff/files, commits, body, linked issue)
 *   GET  /pulls/:id/comments          → inline comments (GitHub review comments /
 *                                        GitLab diff discussions); any host failure → []
 *   POST /pulls/:id/comments          → post one comment or reply on either host
 *                                        (GitLab: as the workspace service account)
 *
 * List reads hit the DB only; the host sync runs detached in the container's
 * single-flight `prSync` coordinator (TTL / back-off / join — AC-55..64).
 *
 * Import is idempotent (unique repo_id+number). Review trigger is MANUAL
 * and owned by A2 — this module only imports/reads.
 */
export default async function pullsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const reads = container.pullsReadRepo;

  /** The workspace-scoped repo, or 404. */
  async function loadRepo(workspaceId: string, repoId: string): Promise<PersistedRepo> {
    const repo = await reads.findRepoForWorkspace(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');
    return repo;
  }

  /**
   * Sync-on-open (AC-55/56): ask the coordinator to start/join a sync, but
   * NEVER make the list read wait on it — the read serves persisted rows only.
   * `onOpen` itself only reads the sync status; the sync is detached.
   */
  function triggerOnOpen(repo: PersistedRepo, log: FastifyBaseLogger): void {
    container.prSync.onOpen(repo).catch((err: unknown) => {
      log.warn({ err, repoId: repo.id }, 'PR sync-on-open trigger failed; serving persisted PRs');
    });
  }

  // GET /repos/:id/pulls — bare PrMeta[] (MCP depends on this shape, Q2).
  app.get('/repos/:id/pulls', { schema: { params: IdParams } }, async (req): Promise<PrMetaHost[]> => {
    const { workspaceId } = await getContext(container, req);
    const repo = await loadRepo(workspaceId, req.params.id);
    triggerOnOpen(repo, req.log);
    return container.pullList.list(workspaceId, repo.id);
  });

  // GET /repos/:id/pulls/page — the UI's list read: rows + sync status (Q2).
  app.get(
    '/repos/:id/pulls/page',
    { schema: { params: IdParams, response: { 200: PrListPage } } },
    async (req): Promise<PrListPage> => {
      const { workspaceId } = await getContext(container, req);
      const repo = await loadRepo(workspaceId, req.params.id);
      // Only the status read is awaited here, never the sync itself (AC-55).
      const trigger = await container.prSync.onOpen(repo);
      const [pulls, snapshot] = await Promise.all([
        container.pullList.list(workspaceId, repo.id),
        container.prSync.snapshot(repo),
      ]);
      return { pulls, sync: { trigger, ...snapshot } };
    },
  );

  // POST /repos/:id/pulls/sync — manual refresh: bypasses TTL/back-off,
  // single-flight (joins a running sync) (AC-57/58).
  app.post(
    '/repos/:id/pulls/sync',
    { schema: { params: IdParams, response: { 200: PrSyncStartResult } } },
    async (req): Promise<PrSyncStartResult> => {
      const { workspaceId } = await getContext(container, req);
      const repo = await loadRepo(workspaceId, req.params.id);
      return { trigger: container.prSync.manual(repo) };
    },
  );

  // GET /repos/:id/pulls/sync/events — completion signal: exactly ONE `done`
  // event, then the server closes the stream (no polling, AC-63). A client
  // disconnect only drops the listener; the sync itself keeps running (AC-64).
  // No rate limit: one long-lived connection, like /runs/:id/events.
  app.get(
    '/repos/:id/pulls/sync/events',
    { schema: { params: IdParams }, config: { rateLimit: false } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      // Authorize BEFORE the SSE handshake so an unknown repo is a normal 404.
      const repo = await loadRepo(workspaceId, req.params.id);
      const coordinator = container.prSync;

      const noop = () => undefined;
      let closed = false;
      // Cancels the pending `waitForDone` (drops the coordinator listener).
      let cancelWait: () => void = noop;
      const onClose = () => {
        closed = true;
        cancelWait();
      };
      reply.raw.once('close', onClose);

      /** Resolves with the running sync's outcome, or null if the client left first. */
      const waitForDone = () =>
        new Promise<PrSyncDoneEvent | null>((resolve) => {
          const off = coordinator.onDone(repo.id, (event) => {
            cancelWait = noop;
            resolve(event);
          });
          cancelWait = () => {
            cancelWait = noop;
            off();
            resolve(null);
          };
          if (closed) cancelWait();
        });

      reply.sse(
        (async function* () {
          try {
            while (!closed) {
              let event: PrSyncDoneEvent | null = null;
              if (coordinator.isRunning(repo.id)) {
                event = await waitForDone();
              } else {
                const snap = await coordinator.snapshot(repo);
                // A sync started while the status was being read → wait for it.
                if (snap.state === 'running') continue;
                event = {
                  state: snap.state,
                  last_synced_at: snap.last_synced_at,
                  last_sync_error: snap.last_sync_error,
                };
              }
              if (!event) break;
              yield { event: 'done', data: JSON.stringify(event) };
              break;
            }
          } catch (err) {
            // The status read failed after the handshake: still honour the
            // "exactly ONE terminal `done`" contract so the client never hangs.
            req.log.error({ err, repoId: repo.id }, 'PR sync status unavailable; closing SSE as failed');
            if (!closed) {
              const failed: PrSyncDoneEvent = {
                state: 'failed',
                last_synced_at: repo.lastSyncedAt?.toISOString() ?? null,
                last_sync_error: 'sync status unavailable',
              };
              yield { event: 'done', data: JSON.stringify(failed) };
            }
          } finally {
            cancelWait();
            reply.raw.off('close', onClose);
          }
        })(),
      );
    },
  );

  // PR detail — the only place diffs/patches/commits are fetched from a host.
  // GitHub always refetches; GitLab only when the head moved (Q6).
  app.get('/pulls/:id', { schema: { params: IdParams } }, async (req): Promise<PrDetailHost> => {
    const { workspaceId } = await getContext(container, req);
    const { pr, repo } = await resolvePrAndRepo(req.params.id, workspaceId);
    return container.pullDetail.refresh(pr, repo, req.log);
  });

  // ---- Inline comments (Files changed tab) --------------------------------
  // Proxied live to the repo's host (no local persistence): GET reflects the
  // existing PR/MR comments; POST creates one immediately. The use case lives in
  // `container.prComments` (both hosts); these routes only translate HTTP.
  async function resolvePrAndRepo(id: string, workspaceId: string) {
    const found = await reads.findPrWithRepo(workspaceId, id);
    if (!found) throw new NotFoundError('Pull request not found');
    const { pr, repo } = found;
    if (!repo) throw new NotFoundError('Repo not found');
    return { pr, repo };
  }

  app.get(
    '/pulls/:id/comments',
    { schema: { params: IdParams, response: { 200: z.array(HostComment) } } },
    async (req): Promise<HostComment[]> => {
      const { workspaceId } = await getContext(container, req);
      const { pr, repo } = await resolvePrAndRepo(req.params.id, workspaceId);
      return container.prComments.list(pr, repo, req.log);
    },
  );

  app.post(
    '/pulls/:id/comments',
    {
      schema: { params: IdParams, body: HostCommentInput, response: { 200: HostComment } },
      // Rec3: a 1,000,000-character comment of multi-byte text exceeds the global
      // 1 MiB limit; let it reach AC-15's `comment_too_long` instead of a 413.
      bodyLimit: COMMENT_BODY_LIMIT_BYTES,
      // AC-14: the blank-body rule lives ONLY in the `HostCommentInput` refine.
      // The handler sees the schema failure first and picks its status.
      // Consequence: the auth preHandler sees an UNVALIDATED body — never give
      // this route a body-dependent policy predicate (e.g. `sessionOnly`) in
      // platform/auth/route-policy.ts without moving validation back.
      attachValidation: true,
    },
    async (req): Promise<HostComment> => {
      // Before auth/tenancy and any host call, exactly as a non-attached failure.
      if (req.validationError) throw commentValidationFailure(req.validationError, req.body);
      // Auth/tenancy first: an unauthenticated request never reaches a host (AC-41).
      const { workspaceId, userId } = await getContext(container, req);
      const { pr, repo } = await resolvePrAndRepo(req.params.id, workspaceId);
      return container.prComments.create(pr, repo, req.body, userId, req.log);
    },
  );
}

/** POST /pulls/:id/comments body limit (4 MiB, plan Rec3). */
const COMMENT_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Status for a failed POST /pulls/:id/comments body (AC-14, AC-34).
 *
 * The blank-body rule has ONE source: the `HostCommentInput` refine, whose
 * failure is a `custom` issue on `body`. When that issue fires for a non-empty
 * string (i.e. whitespace only), the request is a 400 `validation_error` on both
 * hosts. Every other failure — an empty string included (`pulls-comments.it`,
 * GitHub parity) — is rethrown unchanged and becomes the app's 422.
 */
function commentValidationFailure(err: Error, raw: unknown): Error {
  const body = (raw as { body?: unknown } | null)?.body;
  const blankBody =
    hasZodFastifySchemaValidationErrors(err) &&
    err.validation.some(({ params: { issue } }) => issue.code === 'custom' && issue.path.join('.') === 'body');
  if (blankBody && typeof body === 'string' && body.length > 0) {
    return new AppError('validation_error', 'Comment body must not be empty', 400);
  }
  return err;
}
