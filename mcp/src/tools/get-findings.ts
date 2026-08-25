/* devdigest_get_findings — read tool: resolve repo → PR (→ agent), then fetch
   reviews + runs in parallel and map to the concise findings view.
   `running_runs` tells the model a review is still in flight; no reviews is a
   NON-error forward-leading result. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReviewRecord, RunSummary } from '@devdigest/shared';
import type { DevDigestApi } from '../api.js';
import { okResult, toToolError } from '../errors.js';
import { FindingsOutput, mapFindings } from '../mappers.js';
import { resolveAgent, resolvePull, resolveRepo } from '../resolve.js';

export function registerGetFindings(server: McpServer, api: DevDigestApi): void {
  server.registerTool(
    'devdigest_get_findings',
    {
      title: 'Get review findings for a pull request',
      description:
        'Get the verdict, score and findings from already-completed review runs on a pull request. Call this when the user asks what reviewers found, or to fetch results after devdigest_run_agent_on_pr returned "timeout". Does not start a review — use devdigest_run_agent_on_pr for that.',
      inputSchema: {
        repo: z.string().describe('Repository full name, e.g. "acme/payments-api".'),
        pr: z.number().int().describe('Pull request number, e.g. 482.'),
        agent: z.string().optional().describe("Filter to one agent's reviews (name or uuid)."),
        severity: z
          .enum(['CRITICAL', 'WARNING', 'SUGGESTION'])
          .optional()
          .describe('CRITICAL | WARNING | SUGGESTION.'),
        response_format: z
          .enum(['concise', 'detailed'])
          .optional()
          .describe(
            '"concise" (default: severity, title, file, line per finding) or "detailed" (adds rationale, suggestion, confidence).',
          ),
        limit: z.number().int().positive().optional().describe('Max findings to return (default 20).'),
      },
      outputSchema: FindingsOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repo, pr, agent, severity, response_format, limit }) => {
      try {
        const repoRow = await resolveRepo(api, repo);
        const pull = await resolvePull(api, repoRow.id, pr, repoRow.full_name);
        const agentRow = agent !== undefined ? await resolveAgent(api, agent) : undefined;
        const prPath = encodeURIComponent(pull.id);
        const [reviews, runs] = await Promise.all([
          api.get<ReviewRecord[]>(`/pulls/${prPath}/reviews`),
          api.get<RunSummary[]>(`/pulls/${prPath}/runs`),
        ]);
        const out = mapFindings(reviews, runs, {
          repo: repoRow.full_name,
          prNumber: pull.number,
          agentName: agentRow?.name,
          severity,
          format: response_format,
          limit,
        });
        if (reviews.length === 0) {
          out.message = `No reviews yet for PR #${pull.number} in ${repoRow.full_name} — call devdigest_run_agent_on_pr to run one.`;
        }
        return okResult(out);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
