/* render-with-providers.tsx — the ONE shared render helper for component tests.

   Renders the real app provider stack (next-intl with every `messages/en`
   namespace → `Providers` (React Query + Theme + Toasts + the global error
   policy) → optional `RepoProvider`) and answers the app's API calls through a small
   fetch ROUTER stubbed onto `globalThis.fetch`. No hook/session/permission
   mocks are needed: the session probe, role gating and data hooks run for
   real against the routed responses. `EventSource` is a silent stub (live
   run streams render their idle state).

     const { router } = renderWithProviders(<SettingsMembers />, {
       session: "member",
       routes: { "GET /members": list, "PATCH /members/:userId": (req) => ({ ...req.body }) },
     });
     expect(await screen.findByText("Ann Admin")).toBeInTheDocument();

   Assert on what the user sees (`findBy*` / `waitFor` on the DOM); use
   `router.calls` only to check a request PAYLOAD, never as a sync signal. */
import React from "react";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, vi } from "vitest";
import { render, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import type { AuthMode, CurrentSession, RepoWithHost, Role } from "@devdigest/shared";
import { Providers } from "@/lib/providers";
import { RepoProvider } from "@/lib/repo-context";

// ---- i18n: every namespace, read once (mirrors src/i18n/request.ts) ----

// `__dirname` (vite-node injects it); `import.meta.url` is not a file: URL under jsdom.
const MESSAGES_DIR = resolve(__dirname, "../../messages/en");

function loadAllMessages(): AbstractIntlMessages {
  const out: Record<string, AbstractIntlMessages> = {};
  for (const file of readdirSync(MESSAGES_DIR)) {
    if (!file.endsWith(".json")) continue;
    out[file.replace(/\.json$/, "")] = JSON.parse(
      readFileSync(join(MESSAGES_DIR, file), "utf8"),
    ) as AbstractIntlMessages;
  }
  return out;
}

export const testMessages = loadAllMessages();

// ---- session fixtures ----

export const TEST_USER_ID = "u-test";

export function sessionFor(
  role: Role = "admin",
  {
    mode = "google",
    userId = TEST_USER_ID,
    name = "Test User",
  }: { mode?: AuthMode; userId?: string; name?: string } = {},
): CurrentSession {
  return {
    mode,
    user: { id: userId, email: "test@onlytraf.com", name, avatar_url: null, role },
    workspace: { id: "w1", name: "Team" },
  };
}

/** A GitHub repo row as `GET /repos` returns it. */
export function testRepo(overrides: Partial<RepoWithHost> = {}): RepoWithHost {
  return {
    id: "r1",
    workspace_id: "w1",
    owner: "acme",
    name: "payments-api",
    full_name: "acme/payments-api",
    default_branch: "main",
    clone_path: null,
    last_polled_at: null,
    created_by: null,
    provider: "github",
    host: "github.com",
    web_url: "https://github.com/acme/payments-api",
    sync_state: "idle",
    ...overrides,
  };
}

// ---- fetch router ----

export interface RouteRequest {
  method: string;
  path: string;
  /** `:name` segments of the matched route pattern. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (raw string when not JSON; FormData as-is; undefined when absent). */
  body: unknown;
}

/** A handler returns a `Response` (status control) or any value (→ 200 JSON). */
export type RouteHandler = (req: RouteRequest) => unknown;
/** Keys are `"METHOD /path/:param"`; a non-function value is served as 200 JSON. */
export type Routes = Record<string, RouteHandler | unknown>;

/** JSON response with a status. */
export function reply(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The API's error envelope (`{ error: { code, message } }`). */
export function apiError(status: number, code: string, message = code): Response {
  return reply({ error: { code, message } }, status);
}

interface CompiledRoute {
  method: string;
  segments: string[];
  handler: RouteHandler | unknown;
}

const paramCount = (r: CompiledRoute) => r.segments.filter((seg) => seg.startsWith(":")).length;

/** Static routes win over `:param` ones (`/skills/usage` before `/skills/:id`). */
function compile(routes: Routes): CompiledRoute[] {
  return Object.entries(routes)
    .map(([key, handler]) => {
      const [method = "", pattern = ""] = key.trim().split(/\s+/);
      return { method: method.toUpperCase(), segments: pattern.split("/"), handler };
    })
    .sort((a, b) => paramCount(a) - paramCount(b));
}

function match(route: CompiledRoute, method: string, path: string): Record<string, string> | null {
  if (route.method !== method) return null;
  const parts = path.split("/");
  if (parts.length !== route.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = route.segments[i] ?? "";
    const part = parts[i] ?? "";
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
    else if (seg !== part) return null;
  }
  return params;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export interface FetchRouter {
  /** Every request that reached the router, in order (for payload assertions). */
  calls: RouteRequest[];
  /** Requests no route answered (served as 404 `not_found`). */
  unmatched: RouteRequest[];
  /** Add/override routes mid-test (later routes win). */
  use: (routes: Routes) => void;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export function createFetchRouter(initial: Routes = {}): FetchRouter {
  let table = compile(initial);
  const calls: RouteRequest[] = [];
  const unmatched: RouteRequest[] = [];
  const router: FetchRouter = {
    calls,
    unmatched,
    use: (routes) => {
      table = [...compile(routes), ...table];
    },
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      const base: Omit<RouteRequest, "params"> = {
        method,
        path: url.pathname,
        query: url.searchParams,
        body: parseBody(init?.body),
      };
      for (const route of table) {
        const params = match(route, method, url.pathname);
        if (!params) continue;
        const req: RouteRequest = { ...base, params };
        calls.push(req);
        const out =
          typeof route.handler === "function" ? await (route.handler as RouteHandler)(req) : route.handler;
        return out instanceof Response ? out : reply(out);
      }
      const req: RouteRequest = { ...base, params: {} };
      calls.push(req);
      unmatched.push(req);
      return apiError(404, "not_found", `No test route for ${method} ${url.pathname}`);
    },
  };
  return router;
}

// ---- live streams ----

/** jsdom has no EventSource: live run streams open, stay silent, and close. */
export class SilentEventSource {
  readonly url: string;
  readyState = 0;
  constructor(url: string | URL) {
    this.url = String(url);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
}

// ---- render ----

export interface RenderWithProvidersOptions {
  /** Signed-in role (google mode) or a full session; ignored when `routes` answers `GET /auth/session`. Default "admin". */
  session?: Role | CurrentSession;
  /** API routes for this render; merged over the defaults (`GET /auth/session`, `GET /repos` → []). */
  routes?: Routes;
  /** Wrap in the real `RepoProvider` (reads `GET /repos`; needs `usePathname` in the next/navigation mock). */
  repoProvider?: boolean;
}

export interface RenderWithProvidersResult extends RenderResult {
  router: FetchRouter;
}

let fetchStubbed = false;
afterEach(() => {
  if (!fetchStubbed) return;
  vi.unstubAllGlobals();
  fetchStubbed = false;
});

export function renderWithProviders(
  ui: React.ReactElement,
  { session = "admin", routes = {}, repoProvider = false }: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const current = typeof session === "string" ? sessionFor(session) : session;
  const router = createFetchRouter({ "GET /auth/session": current, "GET /repos": [] });
  router.use(routes);
  vi.stubGlobal("fetch", vi.fn(router.fetch));
  vi.stubGlobal("EventSource", SilentEventSource);
  fetchStubbed = true;

  const result = render(
    <NextIntlClientProvider locale="en" messages={testMessages}>
      <Providers queryDefaults={{ retry: false }}>
        {repoProvider ? <RepoProvider>{ui}</RepoProvider> : ui}
      </Providers>
    </NextIntlClientProvider>,
  );
  return { ...result, router };
}
