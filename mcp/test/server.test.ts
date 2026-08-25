/* In-memory MCP integration test: real McpServer + real Client over
   InMemoryTransport, fake DevDigestApi — no network, no stdio, no timers. */

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DevDigestApi } from '../src/api.js';
import { AgentsOutput, BlastRadiusOutput } from '../src/mappers.js';
import { buildServer } from '../src/server.js';
import { AGENT, AGENT_2, BLAST_RESPONSE, PULL, REPO, downApi, fakeApi } from './fixtures.js';

async function connect(api: DevDigestApi): Promise<Client> {
  const server = buildServer(api);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}

describe('devdigest MCP server', () => {
  it('lists all 5 prefixed tools with their annotations', async () => {
    const client = await connect(fakeApi({}));
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'devdigest_get_blast_radius',
      'devdigest_get_conventions',
      'devdigest_get_findings',
      'devdigest_list_agents',
      'devdigest_run_agent_on_pr',
    ]);

    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const readTool of [
      'devdigest_list_agents',
      'devdigest_get_findings',
      'devdigest_get_conventions',
      'devdigest_get_blast_radius',
    ]) {
      expect(byName.get(readTool)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
    }
    expect(byName.get('devdigest_run_agent_on_pr')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('devdigest_list_agents')?.title).toBe('List review agents');
  });

  it('devdigest_list_agents returns conforming structuredContent + mirrored JSON text', async () => {
    const client = await connect(fakeApi({ '/agents': [AGENT, AGENT_2] }));
    const result = (await client.callTool({
      name: 'devdigest_list_agents',
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const parsed = AgentsOutput.parse(result.structuredContent);
    expect(parsed.total).toBe(2);
    expect(parsed.agents.map((a) => a.name)).toEqual(['Security Reviewer', 'Perf Reviewer']);
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));
  });

  it('devdigest_get_findings with an unknown repo → isError with forward-leading message', async () => {
    const client = await connect(fakeApi({ '/repos': [REPO] }));
    const result = (await client.callTool({
      name: 'devdigest_get_findings',
      arguments: { repo: 'nope/nothing', pr: 482 },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Repo "nope/nothing" not found. Known repos: acme/payments-api.',
    );
  });

  it('devdigest_get_blast_radius resolves repo+PR and returns the mapped blast', async () => {
    const client = await connect(
      fakeApi({
        '/repos': [REPO],
        [`/repos/${REPO.id}/pulls`]: [PULL],
        [`/pulls/${PULL.id}/blast`]: BLAST_RESPONSE,
      }),
    );
    const result = (await client.callTool({
      name: 'devdigest_get_blast_radius',
      arguments: { repo: 'acme/payments-api', pr: 482 },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const parsed = BlastRadiusOutput.parse(result.structuredContent);
    expect(parsed.repo).toBe(REPO.full_name);
    expect(parsed.pr_number).toBe(482);
    expect(parsed.status).toBe('ok');
    expect(parsed.counts.symbols).toBe(1);
    expect(parsed.symbols[0]?.callers).toEqual(['src/routes/checkout.ts:42 (checkoutHandler)']);
    expect(parsed.endpoints).toEqual(['POST /checkout']);
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));
  });

  it('devdigest_get_blast_radius degraded blast → NORMAL result (not isError), reason carried', async () => {
    const client = await connect(
      fakeApi({
        '/repos': [REPO],
        [`/repos/${REPO.id}/pulls`]: [PULL],
        [`/pulls/${PULL.id}/blast`]: {
          ...BLAST_RESPONSE,
          status: 'degraded',
          reason: 'the repository index is not built yet — index the repository first.',
          counts: { symbols: 0, callers: 0, endpoints: 0, crons: 0 },
          symbols: [],
          endpoints: [],
          prior_prs: [],
        },
      }),
    );
    const result = (await client.callTool({
      name: 'devdigest_get_blast_radius',
      arguments: { repo: 'acme/payments-api', pr: 482 },
    })) as CallToolResult;

    // degraded/partial explain themselves via `reason` — never an MCP error.
    expect(result.isError).toBeFalsy();
    const parsed = BlastRadiusOutput.parse(result.structuredContent);
    expect(parsed.status).toBe('degraded');
    expect(parsed.reason).toMatch(/index the repository first/);
    expect(parsed.counts).toEqual({ symbols: 0, callers: 0, endpoints: 0, crons: 0 });
    expect(parsed.symbols).toEqual([]);
  });

  it('API down (ECONNREFUSED) → dev.sh guidance from every tool', async () => {
    const client = await connect(downApi());
    for (const call of [
      { name: 'devdigest_list_agents', arguments: {} },
      { name: 'devdigest_get_conventions', arguments: { repo: 'acme/payments-api' } },
      {
        name: 'devdigest_run_agent_on_pr',
        arguments: { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      },
    ]) {
      const result = (await client.callTool(call)) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('DevDigest API is not running — start it with ./scripts/dev.sh');
    }
  });
});
