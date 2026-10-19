import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from '../src/api.js';
import { UNAUTHENTICATED_TEXT, toToolError } from '../src/errors.js';

const BASE = 'http://api.test';
const TOKEN = 'ddg_pat_test-token-value-0123456789abcdefghijklmnop';

type Captured = { url: string; headers: Record<string, string> };

function stubFetch(response: () => Response): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
      return response();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function text(result: ReturnType<typeof toToolError>): string {
  const block = result.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createApi bearer token', () => {
  it('sends Authorization: Bearer <token> on GET and POST when a token is configured', async () => {
    const calls = stubFetch(() => json({ ok: true }));
    const api = createApi(BASE, TOKEN);

    await api.get('/agents');
    await api.post('/pulls/x/runs', { agentId: 'a' });

    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]!.headers['content-type']).toBe('application/json');
  });

  it('sends no Authorization header without a token (local mode, as today)', async () => {
    const calls = stubFetch(() => json({ ok: true }));
    const api = createApi(BASE, undefined);

    await api.get('/agents');
    await api.post('/pulls/x/runs');

    for (const c of calls) {
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    }
    // body-less POST still declares no content-type (unchanged behaviour)
    expect(calls[1]!.headers).toEqual({});
  });

  it('maps a 401 to the create/renew-token guidance without leaking the token', async () => {
    stubFetch(() => json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, 401));
    const api = createApi(BASE, TOKEN);

    const err = await api.get('/agents').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).not.toContain(TOKEN);

    const res = toToolError(err);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(UNAUTHENTICATED_TEXT);
    expect(text(res)).toContain('Settings → API tokens');
    expect(text(res)).toContain('DEVDIGEST_API_TOKEN');
    expect(text(res)).not.toContain(TOKEN);
  });

  it('passes a 403 server message through', async () => {
    stubFetch(() =>
      json({ error: { code: 'forbidden_role', message: 'Only an Admin can change settings' } }, 403),
    );
    const err = await createApi(BASE, TOKEN).post('/settings', { x: 1 }).catch((e: unknown) => e);

    const res = toToolError(err);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Only an Admin can change settings');
    expect(text(res)).not.toContain(TOKEN);
  });
});
