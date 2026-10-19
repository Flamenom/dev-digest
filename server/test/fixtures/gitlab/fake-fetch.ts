/**
 * Hermetic fetch double for the gitlab.com adapter tests — no real network.
 * A handler maps each request to a Response; every request is recorded.
 */
export interface FakeRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** Parsed JSON body (GraphQL), else undefined. */
  body: { query?: string; variables?: Record<string, unknown> } | undefined;
  init: RequestInit;
}

export type FakeHandler = (req: FakeRequest) => Response | Promise<Response>;

export function fakeFetch(handler: FakeHandler) {
  const calls: FakeRequest[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const req: FakeRequest = { method: init.method ?? 'GET', url: new URL(input), headers, body, init };
    calls.push(req);
    return handler(req);
  };
  return { fetch, calls };
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Sleep double: records requested delays, resolves immediately. */
export function fakeSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}
