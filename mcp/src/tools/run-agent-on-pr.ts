/* devdigest_run_agent_on_pr — the one write tool: "result, not operation".
   Resolves repo/PR/agent, fires the (server-side fire-and-forget) review, then
   waits synchronously up to RUN_TIMEOUT_MS, mirroring the web client's polling.
   The POST body is built ONLY from resolved uuids — never from raw tool args. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReviewRecord, ReviewRunResponse } from '@devdigest/shared';
import type { DevDigestApi } from '../api.js';
import { POLL_INTERVAL_MS, RUN_TIMEOUT_MS } from '../config.js';
import { okResult, toToolError, toolError } from '../errors.js';
import { FindingOut, mapRunDone } from '../mappers.js';
import { waitForRun } from '../poll.js';
import { resolveAgent, resolvePull, resolveRepo } from '../resolve.js';

/* Flat object covering both RunOutput branches — MCP outputSchema must be a
   single object shape, so the union is expressed via optional fields. */
const outputSchema = {
  status: z.enum(['done', 'timeout']),
  run_id: z.string(),
  agent_name: z.string().nullable(),
  verdict: z.string().nullable().optional(),
  score: z.number().int().nullable().optional(),
  summary: z.string().nullable().optional(),
  blockers: z.number().int().nullable().optional(),
  findings_count: z.number().int().optional(),
  findings: z.array(FindingOut).optional(),
  truncated: z.boolean().optional(),
  repo: z.string().optional(),
  pr_number: z.number().int().optional(),
  message: z.string().optional(),
};

export function registerRunAgentOnPr(server: McpServer, api: DevDigestApi): void {
  server.registerTool(
    'devdigest_run_agent_on_pr',
    {
      title: 'Run a review agent on a pull request',
      description:
        'Run one DevDigest review agent on a pull request and wait for the result (up to ~2 minutes). Call this when asked to review a PR. Returns the verdict, score, summary and top findings. If the review is still running after the wait budget, returns status "timeout" with a run id — fetch the results later with devdigest_get_findings.',
      inputSchema: {
        repo: z
          .string()
          .describe('Repository full name, e.g. "acme/payments-api" (uuid also accepted).'),
        pr: z
          .number()
          .int()
          .describe('Pull request number as shown on GitHub, e.g. 482 — not an internal uuid.'),
        agent: z
          .string()
          .describe(
            'Agent name (case-insensitive) or uuid; valid values come from devdigest_list_agents.',
          ),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ repo, pr, agent }) => {
      try {
        const repoRow = await resolveRepo(api, repo);
        const pull = await resolvePull(api, repoRow.id, pr, repoRow.full_name);
        const agentRow = await resolveAgent(api, agent);

        const prPath = encodeURIComponent(pull.id);
        const started = await api.post<ReviewRunResponse>(`/pulls/${prPath}/review`, {
          agentId: agentRow.id,
        });
        const runId = started.runs[0]?.run_id;
        if (runId === undefined) {
          return toolError(
            `The API accepted the review request for PR #${pull.number} but returned no run — check the DevDigest API logs and retry.`,
          );
        }

        const waited = await waitForRun(api, pull.id, runId, {
          intervalMs: POLL_INTERVAL_MS,
          timeoutMs: RUN_TIMEOUT_MS,
        });

        if (waited.timedOut) {
          return okResult({
            status: 'timeout',
            run_id: runId,
            repo: repoRow.full_name,
            pr_number: pull.number,
            agent_name: agentRow.name,
            message: `The review is still running after 2 minutes. Call devdigest_get_findings with repo '${repoRow.full_name}' and pr ${pull.number} later to fetch the results.`,
          });
        }

        const run = waited.run;
        if (run.status === 'failed' || run.status === 'cancelled') {
          return toolError(
            `Run ${runId} failed: ${run.error ?? 'unknown error'}. Fix the cause (e.g. missing OPENROUTER key in Settings) and retry, or run a different agent (devdigest_list_agents).`,
          );
        }

        const reviews = await api.get<ReviewRecord[]>(`/pulls/${prPath}/reviews`);
        const review = reviews.find((r) => r.run_id === runId);
        if (!review) {
          return toolError(
            `Run ${runId} finished but its review was not found — call devdigest_get_findings with repo '${repoRow.full_name}' and pr ${pull.number} to inspect the PR's reviews.`,
          );
        }
        return okResult(mapRunDone(run, review));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
