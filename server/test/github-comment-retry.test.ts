/**
 * GitHub comment-write retry rule (AC-33, AC-34). Hermetic: requests are
 * counted at the fetch level, so the bundled Octokit retry/throttling plugins
 * are covered too — a POST must be sent exactly once on 5xx / timeout / network
 * failure, and re-sent only after a rate limit.
 */
import { describe, it, expect } from 'vitest';
import { OctokitGitHubClient, GITHUB_COMMENT_UNCONFIRMED } from '../src/adapters/github/octokit.js';
import type { RepoRef } from '@devdigest/shared';

const TOKEN = 'ghp_secretTokenValue1234567890abcdef';
const REPO: RepoRef = { owner: 'acme', name: 'payments-api' } as RepoRef;

const COMMENT_JSON = {
  id: 42,
  path: 'src/config.ts',
  line: 11,
  original_line: 11,
  side: 'RIGHT',
  body: 'Why hardcode this key?',
  user: { login: 'svc-bot' },
  created_at: '2026-10-20T00:00:00Z',
  html_url: 'https://github.com/acme/payments-api/pull/7#discussion_r42',
};

type Reply = Response | 'hang' | 'network';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch stub that answers from a script and records every call. */
function scriptedFetch(script: Reply[]) {
  const calls: { method: string; url: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input) });
    const next = script.shift() ?? json(500, { message: 'script exhausted' });
    if (next === 'network') throw new TypeError('fetch failed');
    if (next === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch, writeTimeoutMs = 5_000) {
  return new OctokitGitHubClient(TOKEN, {
    fetch: fetchImpl,
    writeTimeoutMs,
    writeRetryBaseDelayMs: 1,
  });
}

const NEW_COMMENT = {
  commitId: 'deadbeef',
  path: 'src/config.ts',
  line: 11,
  side: 'RIGHT' as const,
  body: 'Why hardcode this key?',
};

async function caught(p: Promise<unknown>): Promise<{ code?: string; statusCode?: number; message: string }> {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; statusCode?: number; message: string };
  }
  throw new Error('expected a rejection');
}

describe('OctokitGitHubClient comment writes (AC-33)', () => {
  it('502 → exactly one request, github_comment_failed 502 with the spec message', async () => {
    const f = scriptedFetch([json(502, { message: 'Bad Gateway' })]);
    const err = await caught(client(f.impl).createReviewComment(REPO, 7, NEW_COMMENT));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.method).toBe('POST');
    expect(err.code).toBe('github_comment_failed');
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe(GITHUB_COMMENT_UNCONFIRMED);
  });

  it('network error → exactly one request, 502 unconfirmed', async () => {
    const f = scriptedFetch(['network']);
    const err = await caught(client(f.impl).createReviewComment(REPO, 7, NEW_COMMENT));
    expect(f.calls).toHaveLength(1);
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe(GITHUB_COMMENT_UNCONFIRMED);
  });

  it('429 → 201: retried once, two requests, mapped comment', async () => {
    const f = scriptedFetch([
      json(429, { message: 'Too Many Requests' }, { 'retry-after': '0' }),
      json(201, COMMENT_JSON),
    ]);
    const c = await client(f.impl).createReviewComment(REPO, 7, NEW_COMMENT);
    expect(f.calls).toHaveLength(2);
    expect(c).toMatchObject({ id: 42, path: 'src/config.ts', line: 11, user: 'svc-bot', in_reply_to_id: null });
  });

  it('403 secondary rate limit → 201: two requests', async () => {
    const f = scriptedFetch([
      json(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '0' }),
      json(201, COMMENT_JSON),
    ]);
    const c = await client(f.impl).createReviewComment(REPO, 7, NEW_COMMENT);
    expect(f.calls).toHaveLength(2);
    expect(c.id).toBe(42);
  });

  it('403 with x-ratelimit-remaining: 0 → retried', async () => {
    const f = scriptedFetch([
      json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }),
      json(201, COMMENT_JSON),
    ]);
    await client(f.impl).createReviewComment(REPO, 7, NEW_COMMENT);
    expect(f.calls).toHaveLength(2);
  });

  it('a hanging request with a short timeout → one request, 502 unconfirmed', async () => {
    const f = scriptedFetch(['hang', json(201, COMMENT_JSON)]);
    const err = await caught(client(f.impl, 50).createReviewComment(REPO, 7, NEW_COMMENT));
    expect(f.calls).toHaveLength(1);
    expect(err.code).toBe('github_comment_failed');
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe(GITHUB_COMMENT_UNCONFIRMED);
  });

  it('reply path 502 → one request to the replies endpoint', async () => {
    const f = scriptedFetch([json(502, { message: 'Bad Gateway' })]);
    const err = await caught(
      client(f.impl).createReviewComment(REPO, 7, { ...NEW_COMMENT, inReplyTo: 9 }),
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toMatch(/\/pulls\/7\/comments\/9\/replies$/);
    expect(err.statusCode).toBe(502);
  });

  it('422 → 400 github_comment_failed with the GitHub reason, one request, no token', async () => {
    const f = scriptedFetch([
      json(422, { message: `Validation Failed: line must be part of the diff (token ${TOKEN})` }),
    ]);
    const err = await caught(client(f.impl).createReviewComment(REPO, 7, NEW_COMMENT));
    expect(f.calls).toHaveLength(1);
    expect(err.code).toBe('github_comment_failed');
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/Validation Failed/);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('OctokitGitHubClient reads unchanged (AC-34)', () => {
  it('listReviewComments 503 → 200 is still retried', async () => {
    const f = scriptedFetch([
      json(503, { message: 'Service Unavailable' }, { 'retry-after': '0' }),
      json(200, [COMMENT_JSON]),
    ]);
    const list = await client(f.impl).listReviewComments(REPO, 7);
    expect(f.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(42);
  });
});
