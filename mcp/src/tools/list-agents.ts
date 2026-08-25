/* devdigest_list_agents — read tool: GET /agents → concise agent list. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentListItem } from '@devdigest/shared';
import type { DevDigestApi } from '../api.js';
import { okResult, toToolError } from '../errors.js';
import { AgentsOutput, mapAgents } from '../mappers.js';

export function registerListAgents(server: McpServer, api: DevDigestApi): void {
  server.registerTool(
    'devdigest_list_agents',
    {
      title: 'List review agents',
      description:
        'List the review agents configured in DevDigest, with their ids, names, models and enabled state. Call this when you need a valid agent id or name — e.g. before devdigest_run_agent_on_pr — or when the user asks which reviewers are available.',
      outputSchema: AgentsOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const agents = await api.get<AgentListItem[]>('/agents');
        return okResult(mapAgents(agents));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
