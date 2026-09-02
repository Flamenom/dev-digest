import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import type { ContainerOverrides } from '../src/platform/container.js';
import { MockAuthProvider, MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * No-DB route smoke tests via app.inject(). `/health` and the validation/error
 * envelope don't touch the database (postgres-js connects lazily), so these run
 * without Docker. DB-backed routes are covered in integration.test.ts.
 */
const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/** A syntactically valid uuid — used where the PARAMS must pass and something else must fail. */
const UUID = '3e2a2b52-3b8c-4b34-9a34-0a4c8e2b1c11';

describe('routes (no DB)', () => {
  it('GET /health → ok', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('POST /settings/test-connection (github) returns structured ConnTestResult', async () => {
    const app = await buildApp({
      config,
      overrides: { github: new MockGitHubClient({ login: 'octocat' }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'github' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('github');
    expect(body.ok).toBe(true);
    expect(body.message).toContain('octocat');
    await app.close();
  });

  it('POST /settings/test-connection (openai) uses injected LLM listModels', async () => {
    const app = await buildApp({
      config,
      overrides: {
        llm: { openai: new MockLLMProvider('openai', { models: [{ id: 'gpt-4.1', provider: 'openai' }] }) },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'openai' },
    });
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('intent routes (L03) validate :id at the edge — non-uuid → 422, no DB touched', async () => {
    const app = await buildApp({ config });
    const get = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/intent' });
    expect(get.statusCode).toBe(422);
    expect(get.json().error.code).toBe('validation_error');
    const post = await app.inject({ method: 'POST', url: '/pulls/not-a-uuid/intent' });
    expect(post.statusCode).toBe(422);
    expect(post.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('smart-diff route (L0x) validates :id at the edge — non-uuid → 422, no DB touched', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/smart-diff' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('brief routes validate :id at the edge — non-uuid → 422 on both verbs, no DB touched', async () => {
    const app = await buildApp({ config });
    // Both verbs short-circuit in the zod params schema, BEFORE `getContext`
    // resolves tenancy — so neither needs Postgres nor a briefService.
    const get = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/brief' });
    expect(get.statusCode).toBe(422);
    expect(get.json().error.code).toBe('validation_error');
    const post = await app.inject({ method: 'POST', url: '/pulls/not-a-uuid/brief' });
    expect(post.statusCode).toBe(422);
    expect(post.json().error.code).toBe('validation_error');
    await app.close();
  });

  // -------------------------------------------------------------------------
  // L06 eval pipeline (T13 routes + T12 promote)
  // -------------------------------------------------------------------------

  /**
   * Every uuid-addressed eval route, one non-uuid probe each. These stay
   * DB-free for the same reason the brief probes above do: the zod `params`
   * schema is compiled into fastify's validation stage, which runs BEFORE the
   * handler — so `getContext` (which resolves tenancy through Postgres) is
   * never reached.
   *
   * That property is load-bearing, not incidental. A route that reads or
   * validates its BODY before its params (or that resolves tenancy in a hook)
   * would need Docker to run this file. `POST /findings/:id/eval-case` and
   * `POST /agents/:id/eval-runs` both `safeParse` their OPTIONAL bodies inside
   * the handler precisely to preserve it, and the assertions below are what
   * catches a regression.
   */
  const NON_UUID_EVAL_ROUTES: [method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string][] = [
    ['POST', '/findings/not-a-uuid/eval-case'],
    ['GET', '/findings/not-a-uuid/eval-case-draft'],
    ['GET', '/pulls/not-a-uuid/eval-cases'],
    ['GET', '/agents/not-a-uuid/eval-cases'],
    ['GET', '/eval-cases/not-a-uuid'],
    ['PUT', '/eval-cases/not-a-uuid'],
    ['DELETE', '/eval-cases/not-a-uuid'],
    ['POST', '/eval-cases/not-a-uuid/run'],
    ['POST', '/agents/not-a-uuid/eval-runs'],
    ['GET', '/agents/not-a-uuid/eval-batches'],
    ['GET', '/agents/not-a-uuid/eval-runs'],
    ['GET', '/agents/not-a-uuid/eval-dashboard'],
    ['GET', '/evals/batches/not-a-uuid'],
    // R14 lives in modules/agents but is new in L06 and is uuid-addressed.
    ['POST', '/agents/not-a-uuid/versions/3/promote'],
  ];

  it.each(NON_UUID_EVAL_ROUTES)(
    'eval route %s %s validates :id at the edge — non-uuid → 422, no DB touched',
    async (method, url) => {
      const app = await buildApp({ config });
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('validation_error');
      await app.close();
    },
  );

  it('promote validates :version too — a non-positive-integer version → 422', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${UUID}/versions/not-a-number/promote`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('PUT /eval-cases/:id — a VALID body still 422s on a non-uuid id (params run first)', async () => {
    // The probe above sends no body at all, so on its own it cannot tell a
    // params failure from a body failure. This one carries a body that passes
    // `EvalCaseInput.partial()`, leaving the id as the only possible cause —
    // which is what proves fastify's validation order (params → body) and, with
    // it, that this file needs no Postgres.
    const app = await buildApp({ config });
    const res = await app.inject({
      method: 'PUT',
      url: '/eval-cases/not-a-uuid',
      payload: { name: 'renamed-case' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('GET /evals/compare validates its uuid QUERY params — non-uuid → 422', async () => {
    const app = await buildApp({ config });
    // Both ids are required and both must be uuids; neither reaches the service.
    const missing = await app.inject({ method: 'GET', url: '/evals/compare' });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe('validation_error');
    const bad = await app.inject({
      method: 'GET',
      url: `/evals/compare?base=nope&head=${UUID}`,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('POST /eval-cases with no body → 422 (the body schema is required)', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({ method: 'POST', url: '/eval-cases' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  /**
   * C8 REGRESSION — `POST /findings/:id/eval-case` must never be swallowed by
   * the accept/dismiss handler.
   *
   * `modules/reviews/routes.ts` registers `/findings/:id/${action}` in a loop
   * over LITERAL actions, so the third segment is static today and the two
   * routes cannot collide. This test is the guard against a future refactor to
   * a parametric `/findings/:id/:action`: it asserts the request lands on the
   * EVAL handler by injecting a stub eval seam and looking for its marker in
   * the response. The reviews handler would instead reach for the review
   * service (and Postgres), so a wrong route is a visible failure, not a
   * silently different 404.
   */
  it('C8: POST /findings/:id/eval-case routes to the eval handler, not accept/dismiss', async () => {
    const calls: string[] = [];
    const stubCases = {
      createFromFinding: async (workspaceId: string, findingId: string) => {
        calls.push(`createFromFinding:${workspaceId}:${findingId}`);
        return { created: true, record: { id: 'case-1', name: 'from-finding' } };
      },
    };
    const overrides = {
      auth: new MockAuthProvider(),
      // The three-field seam from platform/container.ts; only `cases` is
      // exercised here, so the other two stay empty stubs.
      evalService: { cases: stubCases, runner: {}, dashboard: {} },
    } as unknown as ContainerOverrides;

    const app = await buildApp({ config, overrides });

    // All three third segments are distinct registrations — no parametric
    // `:action` node exists under `/findings/:id/`.
    expect(app.hasRoute({ method: 'POST', url: '/findings/:id/eval-case' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/findings/:id/accept' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/findings/:id/dismiss' })).toBe(true);

    const res = await app.inject({ method: 'POST', url: `/findings/${UUID}/eval-case` });
    // 201 = created by the EVAL service. The accept/dismiss handler has no such
    // status and would have thrown on the (absent) database.
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'case-1', name: 'from-finding' });
    expect(calls).toEqual([`createFromFinding:w1:${UUID}`]);
    await app.close();
  });

  it('returns 422 structured error on invalid body', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'not-a-provider' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });
});
