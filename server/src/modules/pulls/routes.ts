import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type {
  PrDetailHost,
  GitHubClient,
  PrMetaHost,
  PrReviewComment,
  PrSyncDoneEvent,
} from '@devdigest/shared';
import { PrCommentInput, PrListPage, PrSyncStartResult } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { latestReviewPerAgent, rollupReviews } from '../_shared/review-rollup.js';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { deriveReviewStatus } from './status.js';
import type { PersistedRepo } from './repository.js';

/**
 * F1 — pulls module. PR list (persisted, synced on open) + per-PR detail.
 *   GET  /repos/:id/pulls             → persisted PR list (bare array — MCP
 *                                        relies on it); triggers sync-on-open
 *   GET  /repos/:id/pulls/page        → { pulls, sync } for the UI
 *   POST /repos/:id/pulls/sync        → manual list sync → { trigger }
 *   GET  /repos/:id/pulls/sync/events → SSE: ONE `done` event, then close
 *   GET  /pulls/:id                   → full PR detail (diff/files, commits, body, linked issue)
 *   GET  /pulls/:id/comments          → inline review comments (GitHub; GitLab → [])
 *   POST /pulls/:id/comments          → post one (GitHub; GitLab → 400 provider_read_only)
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

  /**
   * The persisted PR list + per-PR review rollups. DB only — no host calls.
   * `is_draft` / `stats_known` are mapped ONLY when non-null, so a GitHub row
   * (where they are never written) keeps the exact pre-GitLab DTO field set (AC-60).
   */
  async function readPersistedList(workspaceId: string, repoId: string): Promise<PrMetaHost[]> {
    const rows = await reads.listForRepo({ workspaceId, repoId });

    // SCORE + FINDINGS severity breakdown per PR for the list's score ring and
    // findings column, aggregated across ALL agents that reviewed the PR (a PR is
    // typically reviewed by several agents at once). We take each agent's LATEST
    // review (a re-run replaces its prior review, never double-counts), then:
    //   - FINDINGS = SUM of severities across those per-agent-latest reviews;
    //   - SCORE    = the WORST (lowest) score among them, so one agent's blocker
    //                isn't masked by another agent's clean 100.
    // Computed on read (no FK denorm); the list is small, so IN-queries + JS
    // grouping are cheap.
    const prIds = rows.map((r) => r.id);
    // prId → worst score across agents; null when reviewed but unscored, absent
    // when never reviewed (so the column reads "—").
    const scoreByPr = new Map<string, number | null>();
    // Total review cost per PR = SUM of cost across ALL of the PR's agent runs
    // (every reviewer, not just the latest). null when the PR has no priced run
    // yet, so the column reads "—" rather than "$0.00".
    const costByPr = new Map<string, number | null>();
    // prId → summed { CRITICAL, WARNING, SUGGESTION }; absent PRs read `null`.
    const findingsByPr = new Map<
      string,
      { CRITICAL: number; WARNING: number; SUGGESTION: number }
    >();
    if (prIds.length > 0) {
      // `verdict`/`runId` are unused by the list row (N10 freezes it) but are
      // part of the shared rollup's input shape; `createdAt` is what makes
      // "latest per agent" well-defined.
      const reviewRows = await reads.listReviewRollupInputs(workspaceId, prIds);
      // ONE shared implementation of the per-agent-latest rule
      // (`modules/_shared/review-rollup.ts`), so the PR list and the PR brief
      // cannot drift apart. The SQL stays newest-first for the index; the
      // helper's sort is stable, so ties keep this order.
      const latest = latestReviewPerAgent(reviewRows);

      // Findings for exactly those per-agent-latest reviews, keyed by review id.
      // Dismissed findings are NOT excluded — unchanged list behaviour.
      const reviewIds = latest.map((r) => r.id);
      const findingsByReview = new Map<string, { severity: string }[]>();
      if (reviewIds.length > 0) {
        const findingRows = await reads.listFindingSeverities(workspaceId, reviewIds);
        for (const fr of findingRows) {
          const arr = findingsByReview.get(fr.reviewId) ?? [];
          arr.push({ severity: fr.severity });
          findingsByReview.set(fr.reviewId, arr);
        }
      }

      // The list shows no blocker count, so the rollup's blocker input is empty.
      const noBlockers = new Map<string, number | null>();
      const latestByPr = new Map<string, typeof latest>();
      for (const rv of latest) {
        const arr = latestByPr.get(rv.prId) ?? [];
        arr.push(rv);
        latestByPr.set(rv.prId, arr);
      }
      // Only PRs that HAVE a review get an entry: `rollupReviews` cannot tell
      // "reviewed but unscored" (score null, findings {0,0,0}) from "never
      // reviewed" (score null, findings null) — that distinction is the caller's,
      // and here it is exactly "is this PR in `latestByPr`".
      for (const [prId, prLatest] of latestByPr) {
        const rollup = rollupReviews(prLatest, findingsByReview, noBlockers);
        scoreByPr.set(prId, rollup.score);
        findingsByPr.set(prId, {
          CRITICAL: rollup.severities.critical,
          WARNING: rollup.severities.warning,
          SUGGESTION: rollup.severities.suggestion,
        });
      }

      const runRows = await reads.listRunCosts(workspaceId, prIds);
      for (const rr of runRows) {
        if (rr.costUsd != null) costByPr.set(rr.prId, (costByPr.get(rr.prId) ?? 0) + rr.costUsd);
        else if (!costByPr.has(rr.prId)) costByPr.set(rr.prId, null);
      }
    }

    const now = Date.now();
    return rows.map((r) => {
      return {
        id: r.id,
        number: r.number,
        title: r.title,
        author: r.author,
        branch: r.branch,
        base: r.base,
        head_sha: r.headSha,
        additions: r.additions,
        deletions: r.deletions,
        files_count: r.filesCount,
        status: deriveReviewStatus({
          ghStatus: r.status,
          lastReviewedSha: r.lastReviewedSha,
          headSha: r.headSha,
          updatedAt: r.updatedAt,
          now,
        }),
        opened_at: r.openedAt?.toISOString() ?? null,
        updated_at: r.updatedAt?.toISOString() ?? null,
        score: scoreByPr.get(r.id) ?? null,
        cost_usd: costByPr.get(r.id) ?? null,
        findings: findingsByPr.get(r.id) ?? null,
        ...(r.isDraft != null ? { is_draft: r.isDraft } : {}),
        ...(r.statsKnown != null ? { stats_known: r.statsKnown } : {}),
      };
    });
  }

  // GET /repos/:id/pulls — bare PrMeta[] (MCP depends on this shape, Q2).
  app.get('/repos/:id/pulls', { schema: { params: IdParams } }, async (req): Promise<PrMetaHost[]> => {
    const { workspaceId } = await getContext(container, req);
    const repo = await loadRepo(workspaceId, req.params.id);
    triggerOnOpen(repo, req.log);
    return readPersistedList(workspaceId, repo.id);
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
        readPersistedList(workspaceId, repo.id),
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

  // ---- Inline review comments (Files changed tab) -------------------------
  // Proxied live to GitHub (no local persistence): GET reflects existing PR
  // comments; POST creates one immediately. Keeps the tab in lock-step with
  // GitHub and avoids a stale local mirror.
  async function resolvePrAndRepo(id: string, workspaceId: string) {
    const found = await reads.findPrWithRepo(workspaceId, id);
    if (!found) throw new NotFoundError('Pull request not found');
    const { pr, repo } = found;
    if (!repo) throw new NotFoundError('Repo not found');
    return { pr, repo };
  }

  app.get(
    '/pulls/:id/comments',
    { schema: { params: IdParams } },
    async (req): Promise<PrReviewComment[]> => {
      const { workspaceId } = await getContext(container, req);
      const { pr, repo } = await resolvePrAndRepo(req.params.id, workspaceId);
      // GitLab (read-only in the MVP): no comments, and no client is resolved (AC-45).
      if (container.pullDetail.isReadOnly(repo)) return [];
      let gh: GitHubClient;
      try {
        gh = await container.github();
      } catch (err) {
        app.log.warn({ err }, 'GitHub client unavailable; serving no PR comments');
        return [];
      }
      try {
        return await gh.listReviewComments({ owner: repo.owner, name: repo.name }, pr.number);
      } catch (err) {
        app.log.warn({ err }, 'GitHub review-comments fetch skipped (offline / error)');
        return [];
      }
    },
  );

  app.post(
    '/pulls/:id/comments',
    { schema: { params: IdParams, body: PrCommentInput } },
    async (req): Promise<PrReviewComment> => {
      const { workspaceId } = await getContext(container, req);
      const { pr, repo } = await resolvePrAndRepo(req.params.id, workspaceId);
      // Reject BEFORE any host client is resolved or called (AC-44).
      container.pullDetail.assertWritable(repo);
      const input = req.body;
      let gh: GitHubClient;
      try {
        gh = await container.github();
      } catch {
        throw new AppError(
          'github_unavailable',
          'Connect a GitHub token to post comments.',
          400,
        );
      }
      try {
        return await gh.createReviewComment({ owner: repo.owner, name: repo.name }, pr.number, {
          commitId: pr.headSha,
          path: input.path,
          line: input.line,
          ...(input.side ? { side: input.side } : {}),
          body: input.body,
          ...(input.in_reply_to != null ? { inReplyTo: input.in_reply_to } : {}),
        });
      } catch (err) {
        // GitHub rejects comments on lines outside the diff / on closed PRs (422).
        const msg = err instanceof Error ? err.message : 'Failed to post the comment to GitHub.';
        throw new AppError('github_comment_failed', msg, 400, { cause: String(err) });
      }
    },
  );
}
