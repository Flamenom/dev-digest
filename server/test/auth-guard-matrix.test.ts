import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import { registeredRouteKeys } from '../src/platform/auth/guard.js';
import { ROUTE_POLICY, lookupPolicy, unclassifiedRoutes } from '../src/platform/auth/route-policy.js';
import {
  anonymous,
  asSession,
  asToken,
  buildHermeticGoogleApp,
  recording,
  TEST_UUID,
  type HermeticGoogleApp,
} from './helpers/google-mode.js';

/**
 * AC-28, AC-29, AC-57 + Q7 — the Permission matrix, enumerated from the routes
 * the app ACTUALLY registers (onRoute collector), in google mode, hermetic:
 * fake principals and a recording DB proxy that throws on any use.
 *
 * Identity routes (plan Q6) are T22's; until they exist, recorded stand-ins
 * are registered at their policy keys so the session-only rows are exercised
 * now. Once the real routes are registered the stand-ins are skipped.
 */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

const IDENTITY_STANDINS = Object.keys(ROUTE_POLICY).filter((k) =>
  /^(GET|POST|PATCH|DELETE) \/(auth|members|tokens)\b/.test(k),
);

function toRequest(key: string): { method: Method; url: string } {
  const [method, path] = key.split(' ') as [Method, string];
  return { method, url: path.replace(/:[A-Za-z]+/g, TEST_UUID) };
}

describe('auth guard × route policy matrix (google mode, hermetic)', () => {
  let t: HermeticGoogleApp;
  const github = recording('github', new MockGitHubClient({ login: 'octocat' }));
  const llm = recording('llm', new MockLLMProvider('openrouter'));
  const repoService = recording('repoService');
  const standinCalls: string[] = [];
  let keys: string[] = [];

  beforeAll(async () => {
    t = await buildHermeticGoogleApp({
      recordDb: true,
      overrides: {
        github: github.value,
        llm: { openrouter: llm.value, openai: llm.value, anthropic: llm.value },
        repoService: repoService.value as never,
      },
      beforeReady: (app) => {
        for (const key of IDENTITY_STANDINS) {
          const [method, url] = key.split(' ') as [Method, string];
          if (app.hasRoute({ method, url })) continue;
          app.route({ method, url, handler: async () => (standinCalls.push(key), { ok: true }) });
        }
      },
    });
    keys = registeredRouteKeys(t.app);
    github.reset();
    llm.reset();
    repoService.reset();
  });

  afterAll(async () => {
    await t?.close();
  });

  const nonPublic = () => keys.filter((k) => lookupPolicy(...(k.split(' ') as [string, string])).policy.access !== 'public');
  const byAccess = (access: 'admin' | 'member') =>
    keys.filter((k) => lookupPolicy(...(k.split(' ') as [string, string])).policy.access === access);

  it('every registered route is classified in the policy table (Q7)', () => {
    expect(keys.length).toBeGreaterThan(80);
    expect(unclassifiedRoutes(keys)).toEqual([]);
  });

  it('every non-public route → 401 unauthenticated without credentials (AC-28)', async () => {
    const failures: string[] = [];
    for (const key of nonPublic()) {
      const res = await t.app.inject(anonymous(toRequest(key)));
      if (res.statusCode !== 401 || res.json().error?.code !== 'unauthenticated') {
        failures.push(`${key} → ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('HEAD resolves to the GET entry', async () => {
    const res = await t.app.inject(anonymous({ method: 'HEAD', url: '/repos' }));
    expect(res.statusCode).toBe(401);
  });

  it('a revoked/unknown credential is unauthenticated, not anonymous', async () => {
    const res = await t.app.inject(
      anonymous({ method: 'GET', url: '/repos', headers: { cookie: '__Host-ddg_session=nope' } }),
    );
    expect(res.statusCode).toBe(401);
    const bearer = await t.app.inject(
      anonymous({ method: 'GET', url: '/repos', headers: { authorization: 'Bearer ddg_pat_nope' } }),
    );
    expect(bearer.statusCode).toBe(401);
  });

  it('Member session × every Admin route → 403 forbidden_role (AC-29)', async () => {
    const member = t.principals.session('member');
    const admin = byAccess('admin');
    expect(admin.length).toBeGreaterThan(20);
    const failures: string[] = [];
    for (const key of admin) {
      const res = await t.app.inject(asSession(member, toRequest(key)));
      if (res.statusCode !== 403 || res.json().error?.code !== 'forbidden_role') {
        failures.push(`${key} → ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('Member token × every Admin route → 403 (forbidden_role, or session_required first)', async () => {
    const member = t.principals.token('member');
    const failures: string[] = [];
    for (const key of byAccess('admin')) {
      const res = await t.app.inject(asToken(member, toRequest(key)));
      const code = res.json().error?.code;
      if (res.statusCode !== 403 || !['forbidden_role', 'session_required'].includes(code)) {
        failures.push(`${key} → ${res.statusCode} ${code}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('bearer token × every session-only route → 403 session_required (AC-57)', async () => {
    const admin = t.principals.token('admin');
    const sessionOnly = keys.filter((k) => lookupPolicy(...(k.split(' ') as [string, string])).policy.sessionOnly === true);
    expect(sessionOnly.sort()).toEqual(
      ['DELETE /tokens/:id', 'GET /tokens', 'PATCH /members/:userId', 'POST /auth/sign-out', 'POST /tokens'].sort(),
    );
    for (const key of sessionOnly) {
      const res = await t.app.inject(asToken(admin, toRequest(key)));
      expect({ key, status: res.statusCode, code: res.json().error?.code }).toEqual({
        key,
        status: 403,
        code: 'session_required',
      });
    }
  });

  it('bearer token saving a key via test-connection → 403 session_required (AC-57, body predicate)', async () => {
    const admin = t.principals.token('admin');
    const res = await t.app.inject(
      asToken(admin, {
        method: 'POST',
        url: '/settings/test-connection',
        payload: { provider: 'github', key: 'ghp_should_never_be_saved' },
      }),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('session_required');
    expect(res.body).not.toContain('ghp_should_never_be_saved');
  });

  it('none of the denied requests reached a handler, the DB, GitHub, the LLM or the repo service', () => {
    expect(standinCalls).toEqual([]);
    expect(t.dbLog?.calls).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(llm.calls).toEqual([]);
    expect(repoService.calls).toEqual([]);
  });

  it('public routes answer without credentials', async () => {
    const res = await t.app.inject(anonymous({ method: 'GET', url: '/health' }));
    expect(res.statusCode).toBe(200);
  });

  it('allowed requests DO reach the handler (the matrix is not vacuous)', async () => {
    const member = t.principals.session('member');
    const res = await t.app.inject(asSession(member, { method: 'GET', url: '/members' }));
    // Stand-in (until T22) answers 200; the real route needs the DB → anything but 401/403.
    expect([401, 403]).not.toContain(res.statusCode);

    const admin = t.principals.token('admin');
    const ok = await t.app.inject(
      asToken(admin, { method: 'POST', url: '/settings/test-connection', payload: { provider: 'github' } }),
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);
    expect(github.calls).toContain('github.currentLogin');
  });
});

describe('unclassified route default (Q7)', () => {
  it('a route missing from the table is Admin-only and reported as unclassified', async () => {
    const t = await buildHermeticGoogleApp({
      beforeReady: (app) => {
        app.post('/zz-new-feature', async () => ({ ok: true }));
      },
    });
    try {
      expect(unclassifiedRoutes(registeredRouteKeys(t.app))).toEqual(['POST /zz-new-feature']);
      const anon = await t.app.inject(anonymous({ method: 'POST', url: '/zz-new-feature' }));
      expect(anon.statusCode).toBe(401);
      const member = await t.app.inject(
        asSession(t.principals.session('member'), { method: 'POST', url: '/zz-new-feature' }),
      );
      expect(member.statusCode).toBe(403);
      expect(member.json().error.code).toBe('forbidden_role');
      const admin = await t.app.inject(
        asSession(t.principals.session('admin'), { method: 'POST', url: '/zz-new-feature' }),
      );
      expect(admin.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('unknown URLs still 404 (no route → no policy lookup)', async () => {
    const t = await buildHermeticGoogleApp();
    try {
      const res = await t.app.inject(anonymous({ method: 'GET', url: '/definitely/not/a/route' }));
      expect(res.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

describe('route-driven audit descriptors (AC-52, google mode)', () => {
  it('records secret saves (key NAME only) and settings changes; nothing for denied or read requests', async () => {
    const events: Array<Record<string, unknown>> = [];
    const saved: string[] = [];
    const t = await buildHermeticGoogleApp({
      overrides: {
        github: new MockGitHubClient({ login: 'octocat' }),
        audit: { record: async (e) => void events.push({ ...e }) },
        secrets: {
          get: async () => undefined,
          set: async (key: string) => void saved.push(key),
        } as never,
      },
    });
    try {
      const admin = t.principals.session('admin');
      const member = t.principals.session('member');
      const secretValue = 'ghp_audit_must_not_contain_this';

      const ok = await t.app.inject(
        asSession(admin, {
          method: 'POST',
          url: '/settings/test-connection',
          payload: { provider: 'github', key: secretValue },
        }),
      );
      expect(ok.statusCode).toBe(200);
      expect(saved).toEqual(['GITHUB_TOKEN']);

      // No key → a connection test, not a secret save: no event.
      await t.app.inject(
        asSession(admin, { method: 'POST', url: '/settings/test-connection', payload: { provider: 'github' } }),
      );
      // Denied → no event.
      await t.app.inject(
        asSession(member, {
          method: 'POST',
          url: '/settings/test-connection',
          payload: { provider: 'github', key: secretValue },
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        workspaceId: admin.principal.workspaceId,
        actorUserId: admin.principal.userId,
        action: 'secret.save',
        targetType: 'secret',
        targetId: 'GITHUB_TOKEN',
        metadata: { key_name: 'GITHUB_TOKEN' },
      });
      expect(JSON.stringify(events)).not.toContain(secretValue);
      expect(JSON.stringify(events)).not.toContain(admin.sessionId);
    } finally {
      await t.close();
    }
  });

  it('descriptors derive ids from params / response and key names from the body', () => {
    const settings = ROUTE_POLICY['PUT /settings']!.audit!;
    const ctx = { params: {}, body: { theme: 'dark', density: 'compact' }, response: () => ({}) };
    expect(settings.metadata!(ctx)).toEqual({ changed_keys: ['density', 'theme'] });
    const create = ROUTE_POLICY['POST /repos']!.audit!;
    expect(create.targetId!({ params: {}, body: {}, response: () => ({ id: TEST_UUID }) })).toBe(TEST_UUID);
    expect(ROUTE_POLICY['POST /findings/:id/dismiss']!.audit!.action).toBe('finding.dismiss');
  });
});
