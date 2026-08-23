/* In-memory MCP integration test: real McpServer + real Client over
   InMemoryTransport, fake DevDigestApi — no network, no stdio, no timers. */

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DevDigestApi } from '../src/api.js';
import { AgentsOutput } from '../src/mappers.js';
import { buildServer } from '../src/server.js';
import { AGENT, AGENT_2, REPO, downApi, fakeApi } from './fixtures.js';

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

  it('devdigest_get_blast_radius returns a non-error not_implemented stub', async () => {
    const client = await connect(fakeApi({}));
    const result = (await client.callTool({
      name: 'devdigest_get_blast_radius',
      arguments: { repo: 'acme/payments-api', pr: 482 },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      status: 'not_implemented',
      message:
        'Blast radius analysis is not implemented yet. Use devdigest_get_findings for per-file review findings.',
    });
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
