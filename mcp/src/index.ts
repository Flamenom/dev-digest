// stdio bootstrap. stdout is JSON-RPC framing — diagnostics go to stderr only.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApi } from './api.js';
import { buildServer } from './server.js';

await buildServer(createApi()).connect(new StdioServerTransport());
console.error('[devdigest-mcp] stdio server running');
