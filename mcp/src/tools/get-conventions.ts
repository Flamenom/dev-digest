/* devdigest_get_conventions — read tool: resolve repo → GET
   /repos/:id/conventions → concise convention list (status filter, default
   'all'). Empty before the first scan is a NON-error forward-leading result. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ConventionListResponse } from '@devdigest/shared';
import type { DevDigestApi } from '../api.js';
import { okResult, toToolError } from '../errors.js';
import { ConventionsOutput, mapConventions } from '../mappers.js';
import { resolveRepo } from '../resolve.js';

export function registerGetConventions(server: McpServer, api: DevDigestApi): void {
  server.registerTool(
    'devdigest_get_conventions',
    {
      title: 'Get repository coding conventions',
      description:
        "Get the coding conventions DevDigest extracted for a repository (category, rule, status, confidence). Call this when you need the repo's conventions — e.g. to check code against them or summarize them for the user.",
      inputSchema: {
        repo: z.string().describe('Repository full name, e.g. "acme/payments-api".'),
        status: z
          .enum(['pending', 'accepted', 'rejected', 'all'])
          .optional()
          .describe('pending | accepted | rejected | all (default "all").'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max conventions to return (default 50).'),
      },
      outputSchema: ConventionsOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repo, status, limit }) => {
      try {
        const repoRow = await resolveRepo(api, repo);
        const resp = await api.get<ConventionListResponse>(
          `/repos/${encodeURIComponent(repoRow.id)}/conventions`,
        );
        const out = mapConventions(repoRow.full_name, resp, { status, limit });
        if (resp.conventions.length === 0 && resp.stats == null) {
          out.message = `No conventions extracted yet for ${repoRow.full_name} — extract them in the DevDigest UI at /conventions.`;
        }
        return okResult(out);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
