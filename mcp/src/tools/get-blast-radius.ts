/* devdigest_get_blast_radius — read tool: resolve repo + PR → GET
   /pulls/:id/blast → concise structured blast radius (changed symbols, their
   callers capped for token economy, impacted endpoints/crons, prior PRs).
   degraded/partial/empty are NORMAL results carrying a `reason`, never
   isError — only transport/resolution failures go through toToolError. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BlastResponse } from '@devdigest/shared';
import type { DevDigestApi } from '../api.js';
import { okResult, toToolError } from '../errors.js';
import { BlastRadiusOutput, mapBlast } from '../mappers.js';
import { resolvePull, resolveRepo } from '../resolve.js';

export function registerGetBlastRadius(server: McpServer, api: DevDigestApi): void {
  server.registerTool(
    'devdigest_get_blast_radius',
    {
      title: 'Get blast radius of a pull request',
      description:
        "Get the blast radius of a PR's changes: changed symbols, their cross-file callers (file:line), HTTP endpoints and cron jobs the changes can reach, plus prior PRs touching the same files. Call this when you need to know what a PR might break or how far its changes propagate. Deterministic (computed from the repo index, no LLM); status degraded/partial/empty explains itself via `reason`.",
      inputSchema: {
        repo: z.string().describe('Repository full name, e.g. "acme/payments-api".'),
        pr: z.number().int().describe('Pull request number.'),
      },
      outputSchema: BlastRadiusOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repo, pr }) => {
      try {
        const repoRow = await resolveRepo(api, repo);
        const pull = await resolvePull(api, repoRow.id, pr, repoRow.full_name);
        const resp = await api.get<BlastResponse>(
          `/pulls/${encodeURIComponent(pull.id)}/blast`,
        );
        return okResult(mapBlast(repoRow.full_name, pr, resp));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
