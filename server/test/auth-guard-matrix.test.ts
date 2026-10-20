import { request } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import { registeredRouteKeys } from '../src/platform/auth/guard.js';
import { auditWritesSettled } from '../src/platform/auth/audit-hook.js';
import {
  ROUTE_POLICY,
  lookupPolicy,
  savedSecretKeyName,
  unclassifiedRoutes,
} from '../src/platform/auth/route-policy.js';
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
  it('secret saves are audited with the write (key NAME only); a failed save, a denied or a no-key request records nothing', async () => {
    const events: Array<Record<string, unknown>> = [];
    const saved: string[] = [];
    const t = await buildHermeticGoogleApp({
      overrides: {
        github: new MockGitHubClient({ login: 'octocat' }),
        audit: { record: async (e) => void events.push({ ...e }) },
        secrets: {
          get: async () => undefined,
          set: async (key: string, value: string) => {
            if (value === 'ghp_write_fails') throw new Error('disk full');
            saved.push(key);
          },
        } as never,
      },
    });
    try {
      const admin = t.principals.session('admin');
      const member = t.principals.session('member');
      const secretValue = 'ghp_audit_must_not_contain_this';

      // G4: the save itself fails → test-connection still answers 200 { ok: false },
      // but nothing was written, so nothing is audited (not keyed on the HTTP status).
      // GitHub, not GitLab: a GitLab key is scope-probed on gitlab.com BEFORE any
      // save (spec 2026-10-20 AC-21), which would make this test hit the network.
      const failed = await t.app.inject(
        asSession(admin, {
          method: 'POST',
          url: '/settings/test-connection',
          payload: { provider: 'github', key: 'ghp_write_fails' },
        }),
      );
      expect(failed.statusCode).toBe(200);
      expect(failed.json()).toMatchObject({ ok: false });
      expect(events).toHaveLength(0);

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

      await auditWritesSettled(t.app); // nothing hook-driven pending; the row was written in-request
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

  it('auditWritesSettled right after inject always sees the row (write registered before the reply)', async () => {
    const events: Array<Record<string, unknown>> = [];
    const t = await buildHermeticGoogleApp({
      overrides: {
        github: new MockGitHubClient({ login: 'octocat' }),
        // A slow write: the row lands well after the response.
        audit: {
          record: async (e) => {
            await new Promise((r) => setTimeout(r, 30));
            events.push({ ...e });
          },
        },
        // `DELETE /repos/:id` is audited by the hook (route descriptor `repo.remove`).
        repoService: { registerCloneJobHandler: () => undefined, remove: async () => undefined } as never,
      },
    });
    try {
      const admin = t.principals.session('admin');
      for (let i = 0; i < 5; i++) {
        const res = await t.app.inject(asSession(admin, { method: 'DELETE', url: `/repos/${TEST_UUID}` }));
        expect(res.statusCode).toBe(200);
        await auditWritesSettled(t.app);
        expect(events).toHaveLength(i + 1);
      }
    } finally {
      await t.close();
    }
  });

  it('a committed mutation whose client aborts mid-response still produces its audit row', async () => {
    const events: Array<Record<string, unknown>> = [];
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((r) => (releaseSave = r));
    let entered!: () => void;
    const saveEntered = new Promise<void>((r) => (entered = r));
    let aborted!: () => void;
    const abortSeen = new Promise<void>((r) => (aborted = r));
    const t = await buildHermeticGoogleApp({
      overrides: {
        github: new MockGitHubClient({ login: 'octocat' }),
        audit: { record: async (e) => void events.push({ ...e }) },
        // The mutation "commits" only after the client has gone away
        // (`DELETE /repos/:id` → hook-audited `repo.remove`).
        repoService: {
          registerCloneJobHandler: () => undefined,
          remove: async () => {
            entered();
            await saveGate;
          },
        } as never,
      },
    });
    try {
      const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
      // The server-side socket closing = the client is gone before the reply.
      t.app.server.on('connection', (socket) => socket.on('close', () => aborted()));
      const admin = t.principals.session('admin');
      const req = asSession(admin, { method: 'DELETE', url: `/repos/${TEST_UUID}` });
      const client = request(`${address}/repos/${TEST_UUID}`, {
        method: 'DELETE',
        headers: { ...(req.headers as Record<string, string>) },
      });
      client.on('error', () => undefined); // the abort below surfaces as ECONNRESET
      client.end();

      // Wait until the handler is blocked in the save, then drop the socket.
      await saveEntered;
      client.destroy();
      await abortSeen;
      releaseSave();

      await vi.waitFor(async () => {
        await auditWritesSettled(t.app);
        expect(events).toHaveLength(1);
      });
      expect(events[0]).toMatchObject({
        actorUserId: admin.principal.userId,
        action: 'repo.remove',
        targetId: TEST_UUID,
      });
    } finally {
      await t.close();
    }
  });

  it('descriptors derive ids from params / response; settings + secret saves have none (service-audited)', () => {
    // G4: `settings.update` / `secret.save` are written by SettingsService in the
    // write's transaction — a hook descriptor here would double-write them.
    expect(ROUTE_POLICY['PUT /settings']!.audit).toBeUndefined();
    expect(ROUTE_POLICY['POST /settings/test-connection']!.audit).toBeUndefined();
    const create = ROUTE_POLICY['POST /repos']!.audit!;
    expect(create.targetId!({ params: {}, body: {}, response: () => ({ id: TEST_UUID }) })).toBe(TEST_UUID);
    expect(ROUTE_POLICY['POST /findings/:id/dismiss']!.audit!.action).toBe('finding.dismiss');
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'secret-save session check: prototype key provider %s → no key name',
    (provider) => {
      const body = { provider, key: 'some-value' };
      expect(savedSecretKeyName(body)).toBeNull();
      const policy = ROUTE_POLICY['POST /settings/test-connection']!;
      expect(typeof policy.sessionOnly === 'function' && policy.sessionOnly({ body })).toBe(false);
    },
  );
});
