/* devdigest_get_blast_radius — honest stub, registered now so the tool surface
   is stable. Returns a NON-error not_implemented result (an isError would read
   as a retryable failure to Claude). When blast radius lands server-side, only
   this file's description/outputSchema/handler change — the flat args stay. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DevDigestApi } from '../api.js';
import { okResult } from '../errors.js';
import { BlastRadiusOutput } from '../mappers.js';

export function registerGetBlastRadius(server: McpServer, _api: DevDigestApi): void {
  server.registerTool(
    'devdigest_get_blast_radius',
    {
      title: 'Get blast radius of a pull request (not implemented yet)',
      description:
        "Not yet implemented; returns a stub response. Will map which files and symbols a PR's changes impact. For per-file review findings today, use devdigest_get_findings.",
      inputSchema: {
        repo: z.string().describe('Repository full name.'),
        pr: z.number().int().describe('Pull request number.'),
      },
      outputSchema: BlastRadiusOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      okResult({
        status: 'not_implemented',
        message:
          'Blast radius analysis is not implemented yet. Use devdigest_get_findings for per-file review findings.',
      }),
  );
}
