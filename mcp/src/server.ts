/* server.ts — composition root. buildServer(api) wires every tool module to
   one McpServer; index.ts connects it to stdio, tests connect it to an
   InMemoryTransport with a fake DevDigestApi. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DevDigestApi } from './api.js';
import { registerGetBlastRadius } from './tools/get-blast-radius.js';
import { registerGetConventions } from './tools/get-conventions.js';
import { registerGetFindings } from './tools/get-findings.js';
import { registerListAgents } from './tools/list-agents.js';
import { registerRunAgentOnPr } from './tools/run-agent-on-pr.js';

// Loaded into every Claude Code session — keep minimal (verbatim from the plan).
const INSTRUCTIONS =
  'DevDigest is a local AI pull-request review studio. Use its tools to list review agents, run a review on a PR, and read findings and repo conventions.';

export function buildServer(api: DevDigestApi): McpServer {
  const server = new McpServer(
    { name: 'devdigest', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );
  registerListAgents(server, api);
  registerRunAgentOnPr(server, api);
  registerGetFindings(server, api);
  registerGetConventions(server, api);
  registerGetBlastRadius(server, api);
  return server;
}
