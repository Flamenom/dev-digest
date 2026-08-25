import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import { ResolveError, notFoundHint, okResult, toToolError, toolError } from '../src/errors.js';

function text(result: ReturnType<typeof toToolError>): string {
  const block = result.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}

describe('toToolError', () => {
  it('maps network failure (status 0) to the dev.sh guidance', () => {
    const res = toToolError(new ApiError('Cannot reach the DevDigest API at http://localhost:3001', 0, 'network_error'));
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('DevDigest API is not running — start it with ./scripts/dev.sh');
  });

  it('maps a raw ECONNREFUSED errno to the dev.sh guidance', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3001'), { code: 'ECONNREFUSED' });
    expect(text(toToolError(err))).toBe('DevDigest API is not running — start it with ./scripts/dev.sh');
  });

  it('maps 404 to the caller-supplied next step', () => {
    const res = toToolError(new ApiError('PR not found', 404), {
      notFound: 'PR not found — list PRs in the DevDigest UI first.',
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('PR not found — list PRs in the DevDigest UI first.');
  });

  it('maps 404 without context to a generic forward-leading default', () => {
    const res = toToolError(new ApiError('Repo not found', 404));
    expect(text(res)).toBe('Not found: Repo not found. Check the arguments and retry.');
  });

  it('maps 429 to wait-a-minute guidance', () => {
    const res = toToolError(new ApiError('Too Many Requests', 429));
    expect(text(res)).toBe(
      'Rate limited by the DevDigest API (reviews are capped at 10/min) — wait a minute and retry.',
    );
  });

  it('maps 400 to an echo of the API message plus a valid-input hint', () => {
    const res = toToolError(new ApiError('agentId must be a uuid', 400));
    expect(text(res)).toBe('Invalid request: agentId must be a uuid. Check the arguments and retry with valid values.');
  });

  it('maps an HTTP timeout to a retry hint', () => {
    const res = toToolError(new ApiError('Request to /agents timed out after 15000ms', 0, 'timeout'));
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(
      'The DevDigest API did not respond in time (Request to /agents timed out after 15000ms) — retry in a moment.',
    );
  });

  it('maps other statuses to a generic retry/logs message', () => {
    const res = toToolError(new ApiError('Internal Server Error', 500));
    expect(text(res)).toBe('DevDigest API error 500: Internal Server Error. Retry; if it persists, check the API logs.');
  });

  it('surfaces ResolveError messages verbatim', () => {
    const res = toToolError(new ResolveError('Agent "x" not found. Known agents: a, b. Call devdigest_list_agents.'));
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Agent "x" not found. Known agents: a, b. Call devdigest_list_agents.');
  });

  it('never throws — non-Error values become isError results too', () => {
    for (const weird of [undefined, null, 'boom', 42, {}]) {
      const res = toToolError(weird);
      expect(res.isError).toBe(true);
      expect(text(res).length).toBeGreaterThan(0);
    }
  });
});

describe('result factories', () => {
  it('toolError produces an isError text result', () => {
    const res = toolError('do X next');
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('do X next');
  });

  it('okResult mirrors structuredContent into a JSON text block', () => {
    const res = okResult({ total: 1 });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ total: 1 });
    expect(text(res)).toBe(JSON.stringify({ total: 1 }));
  });
});

describe('notFoundHint', () => {
  it('lists known values', () => {
    expect(notFoundHint('repos', ['acme/payments-api', 'acme/web'])).toBe(
      'Known repos: acme/payments-api, acme/web.',
    );
  });
  it('says nothing is configured when the list is empty', () => {
    expect(notFoundHint('agents', [])).toBe('No agents configured yet.');
  });
});
