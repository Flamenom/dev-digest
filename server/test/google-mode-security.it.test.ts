import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Review, VerifiedIdentity } from '@devdigest/shared';
import { SecretsStatusDetailed } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import {
  anonymous,
  asSession,
  asToken,
  buildGoogleApp,
  TEST_ORIGIN,
  type GoogleTestApp,
  type SessionCredential,
  type TokenCredential,
} from './helpers/google-mode.js';
import { MockEmbedder, MockGitClient, MockLLMProvider } from '../src/adapters/mocks.js';
import { OAUTH_BINDING_COOKIE, SESSION_COOKIE } from '../src/modules/identity/constants.js';
import * as t from '../src/db/schema.js';

/**
 * T28 — google-mode security scan, end to end over `app.inject` (real Postgres,
 * MockIdentityProvider, mock LLM, stubbed provider `fetch`).
 *
 * One realistic scenario: Google sign-in via start → callback (Admin by
 * allowlist + a Member + a rejected outsider), every managed key saved through
 * `POST /settings/test-connection`, a settings change, a personal token created,
 * used for a review (mock LLM), revoked; accept / dismiss; review + run delete;
 * role change, deactivation, reactivation; sign-out; then a restart with the
 * previous master key (re-encryption). Every response (status, headers, body)
 * and every log line (pino stream, `trace` level) is captured, then every
 * text / varchar / json / jsonb / array / bytea column of every table is dumped.
 *
 * Assertions:
 *  - no secret value, master key (raw / base64 / base64url / hex), Google
 *    client secret, session id, binding cookie, API token, OAuth code, ID
 *    token or PKCE verifier appears in the DB, the logs or any response —
 *    except the one response that legitimately delivers it (the start
 *    redirect carries `state`/`nonce` + the binding cookie, the callback's
 *    Set-Cookie carries the new session, `POST /tokens` shows the token once)
 *    (AC-37, AC-52, Non-functional → Logging);
 *  - each AC-52 action of the scenario yields exactly one audit row with
 *    actor / action / target / time (AC-52, Q10);
 *  - both SSE endpoints answer 401 JSON before any stream opens without a
 *    valid session or token (AC-54).
 * Synthetic values only.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[google-mode-security] Docker not available — skipping.');

// ---- synthetic secrets --------------------------------------------------------

const rnd = (n = 12) => randomBytes(n).toString('hex');
const MASTER_1 = randomBytes(32);
const MASTER_2 = randomBytes(32);
const CLIENT_SECRET = `synthetic-google-client-secret-${rnd()}`;
const ADMIN_EMAIL = `ada.${rnd(4)}@onlytraf.com`;
const ADA_SUB = `sub-ada-${rnd(4)}`;

const SECRET_VALUES = {
  openai: `sk-synthOPENAI${rnd()}`,
  anthropic: `sk-ant-synthANTHROPIC${rnd()}`,
  openrouter: `sk-or-synthOPENROUTER${rnd()}`,
  github: `ghp_synthGITHUB${rnd()}`,
  gitlab: `glpat-synthGITLAB${rnd()}`,
} as const;

// ---- review fixture -----------------------------------------------------------

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

const REVIEW: Review = {
  verdict: 'request_changes',
  summary: 'Hardcoded secret.',
  score: 40,
  findings: [
    {
      id: 'f-1',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded Stripe secret key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'A live key is committed.',
      suggestion: 'Use an env var.',
      confidence: 0.95,
      kind: 'finding',
    },
  ],
};

const overrides = () => ({
  embedder: new MockEmbedder(),
  git: new MockGitClient({ diff: DIFF }),
  llm: {
    openai: new MockLLMProvider('openai', { structured: REVIEW }),
    anthropic: new MockLLMProvider('anthropic', { structured: REVIEW }),
    openrouter: new MockLLMProvider('openrouter', { structured: REVIEW }),
  },
});

const env = (extra: Record<string, string | undefined> = {}) => ({
  LOG_LEVEL: 'trace',
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  AUTH_ADMIN_EMAILS: ADMIN_EMAIL,
  SECRETS_MASTER_KEY: MASTER_1.toString('base64'),
  ...extra,
});

// ---- capture -------------------------------------------------------------------

interface Captured {
  label: string;
  status: number;
  headers: string;
  body: string;
}

interface Sensitive {
  what: string;
  value: string;
  /** Labels of the ONE response allowed to carry it (delivery), if any. */
  allowedIn?: string[];
}

/** Every place a credential can show up as text. */
function forms(value: string): string[] {
  return [value, encodeURIComponent(value)];
}

function masterKeyForms(key: Buffer): string[] {
  return [key.toString('base64'), key.toString('base64url'), key.toString('hex')];
}

d('google-mode security scan (T28, Postgres)', () => {
  let pg: PgFixture;
  const logs: string[] = [];
  const logStream = { write: (line: string) => void logs.push(line) };
  const captured: Captured[] = [];
  const sensitive: Sensitive[] = [];
  let seq = 0;

  /** Inject + record the full response. */
  async function send(app: GoogleTestApp, label: string, opts: InjectOptions): Promise<LightMyRequestResponse> {
    const res = await app.app.inject(opts);
    captured.push({ label, status: res.statusCode, headers: JSON.stringify(res.headers), body: res.payload });
    return res;
  }

  const sessionFromResponse = (res: LightMyRequestResponse) =>
    res.cookies.find((c) => c.name === SESSION_COOKIE && c.value !== '')?.value;

  /** start → (IdP) → callback, registering every flow credential as sensitive. */
  async function googleSignIn(
    app: GoogleTestApp,
    who: Partial<VerifiedIdentity>,
  ): Promise<{ session: SessionCredential | null; callback: LightMyRequestResponse }> {
    const n = ++seq;
    const startLabel = `start#${n}`;
    const callbackLabel = `callback#${n}`;
    const start = await send(app, startLabel, anonymous({ method: 'GET', url: '/auth/google/start?return_to=/repos' }));
    expect(start.statusCode).toBe(302);
    const loc = new URL(String(start.headers.location));
    const state = loc.searchParams.get('state')!;
    const nonce = loc.searchParams.get('nonce')!;
    const binding = start.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE)!.value;
    const code = `4/0synthCODE${rnd()}`;
    app.idp.scriptCode(code, who);

    const callback = await send(
      app,
      callbackLabel,
      anonymous({
        method: 'GET',
        url: `/auth/google/callback?${new URLSearchParams({ code, state }).toString()}`,
        headers: { cookie: `${OAUTH_BINDING_COOKIE}=${binding}` },
      }),
    );
    expect(callback.statusCode).toBe(302);

    const exchange = app.idp.callsOf('exchangeCode').at(-1)!;
    const verify = app.idp.callsOf('verifyIdToken').at(-1);
    sensitive.push(
      { what: `oauth state #${n}`, value: state, allowedIn: [startLabel] },
      { what: `oauth nonce #${n}`, value: nonce, allowedIn: [startLabel] },
      { what: `oauth binding cookie #${n}`, value: binding, allowedIn: [startLabel] },
      { what: `oauth code #${n}`, value: code },
      { what: `pkce code_verifier #${n}`, value: exchange.input.codeVerifier },
    );
    if (verify) sensitive.push({ what: `id token #${n}`, value: verify.input.idToken });

    const value = sessionFromResponse(callback);
    if (!value) return { session: null, callback };
    sensitive.push({ what: `session id #${n}`, value, allowedIn: [callbackLabel] });
    return { session: { cookie: `${SESSION_COOKIE}=${value}`, sessionId: value }, callback };
  }

  let app1: GoogleTestApp;
  let workspaceId: string;
  let adaId: string;
  let bobId: string;
  let ada: SessionCredential;
  let bob: SessionCredential;
  let bobToken: TokenCredential & { id: string };
  let runId: string;
  let repoId: string;
  let findingId: string;
  let reviewId: string;
  let revokedTokenId: string;
  let addedRepoId: string;
  let auditAgentId: string;
  let auditSkillId: string;

  beforeAll(async () => {
    pg = await startPg();
    sensitive.push(
      { what: 'Google client secret', value: CLIENT_SECRET },
      ...Object.entries(SECRET_VALUES).map(([p, v]) => ({ what: `${p} secret value`, value: v })),
    );
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app1?.close().catch(() => undefined);
    await pg?.stop();
  });

  it('drives the full google-mode scenario', async () => {
    // Provider HTTP (GitHub / GitLab test-connection) answered locally.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('api.github.com')) return json({ login: 'octo-admin', id: 1 });
      if (url.includes('gitlab')) {
        return json({ id: 1, username: 'octo', name: 'tok', active: true, revoked: false, scopes: ['api'] });
      }
      return new Response('not stubbed', { status: 404 });
    });

    app1 = await buildGoogleApp({ pg, env: env(), bootChecks: true, logStream, overrides: overrides() });
    workspaceId = app1.workspaceId;

    // ── sign-in: allowlisted Admin, a Member, a rejected outsider ────────────
    const adaIn = await googleSignIn(app1, {
      subject: ADA_SUB,
      email: ADMIN_EMAIL,
      hostedDomain: 'onlytraf.com',
      name: 'Ada Admin',
    });
    ada = adaIn.session!;
    const bobEmail = `bob.${rnd(4)}@onlytraf.com`;
    const bobIn = await googleSignIn(app1, {
      subject: `sub-bob-${rnd(4)}`,
      email: bobEmail,
      hostedDomain: 'onlytraf.com',
      name: 'Bob Member',
    });
    bob = bobIn.session!;
    const outsider = await googleSignIn(app1, {
      subject: `sub-mallory-${rnd(4)}`,
      email: `mallory.${rnd(4)}@evil.example`,
      hostedDomain: 'evil.example',
      name: 'Mallory',
    });
    expect(outsider.session).toBeNull();
    expect(String(outsider.callback.headers.location)).toMatch(new RegExp(`^${TEST_ORIGIN}/sign-in\\?error=`));

    const me = await send(app1, 'session-probe', asSession(ada, { method: 'GET', url: '/auth/session' }));
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe('admin');
    const members = await send(app1, 'members', asSession(ada, { method: 'GET', url: '/members' }));
    expect(members.statusCode).toBe(200);
    const list = (members.json() as { members: Array<{ user_id: string; email: string }> }).members;
    adaId = list.find((m) => m.email === ADMIN_EMAIL)!.user_id;
    bobId = list.find((m) => m.email === bobEmail)!.user_id;
    expect(adaId).toBeTruthy();
    expect(bobId).toBeTruthy();

    // ── every managed key saved (secret.save ×5) + a settings change ─────────
    for (const [provider, key] of Object.entries(SECRET_VALUES)) {
      const res = await send(
        app1,
        `save-${provider}`,
        asSession(ada, { method: 'POST', url: '/settings/test-connection', payload: { provider, key } }),
      );
      expect(res.statusCode, provider).toBe(200);
    }
    const status = await send(app1, 'secrets-status', asSession(ada, { method: 'GET', url: '/settings/secrets-status' }));
    const parsed = SecretsStatusDetailed.parse(status.json());
    for (const p of Object.keys(SECRET_VALUES) as (keyof typeof SECRET_VALUES)[]) {
      expect(parsed.states[p].state, p).toBe('set');
    }
    expect(
      (await send(app1, 'settings-put', asSession(ada, { method: 'PUT', url: '/settings', payload: { theme: 'light' } })))
        .statusCode,
    ).toBe(200);

    // ── route-driven Admin actions (audit hook descriptors, AC-52) ───────────
    const repoAdd = await send(
      app1,
      'repo-add',
      asSession(ada, { method: 'POST', url: '/repos', payload: { url: `https://github.com/acme/audit-${rnd(4)}` } }),
    );
    expect(repoAdd.statusCode).toBe(201);
    addedRepoId = (repoAdd.json() as { id: string }).id;
    expect(
      (await send(app1, 'repo-remove', asSession(ada, { method: 'DELETE', url: `/repos/${addedRepoId}` }))).statusCode,
    ).toBe(200);

    const agentCreate = await send(
      app1,
      'agent-create',
      asSession(ada, {
        method: 'POST',
        url: '/agents',
        payload: { name: `Audit agent ${rnd(4)}`, provider: 'openai', model: 'gpt-4o-mini', system_prompt: 'Review the diff.' },
      }),
    );
    expect(agentCreate.statusCode).toBeLessThan(300);
    auditAgentId = (agentCreate.json() as { id: string }).id;
    expect(
      (
        await send(app1, 'agent-update', asSession(ada, {
          method: 'PUT',
          url: `/agents/${auditAgentId}`,
          payload: { system_prompt: 'Review the diff carefully.' },
        }))
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await send(app1, 'agent-promote', asSession(ada, {
          method: 'POST',
          url: `/agents/${auditAgentId}/versions/1/promote`,
        }))
      ).statusCode,
    ).toBeLessThan(300);
    expect(
      (await send(app1, 'agent-delete', asSession(ada, { method: 'DELETE', url: `/agents/${auditAgentId}` }))).statusCode,
    ).toBeLessThan(300);

    const skillCreate = await send(
      app1,
      'skill-create',
      asSession(ada, {
        method: 'POST',
        url: '/skills',
        payload: { name: `audit-skill-${rnd(4)}`, description: 'd', type: 'rubric', body: 'v1 body' },
      }),
    );
    expect(skillCreate.statusCode).toBeLessThan(300);
    auditSkillId = (skillCreate.json() as { id: string }).id;
    expect(
      (
        await send(app1, 'skill-update', asSession(ada, {
          method: 'PUT',
          url: `/skills/${auditSkillId}`,
          payload: { body: 'v2 body', note: 'tighten' },
        }))
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await send(app1, 'skill-restore', asSession(ada, {
          method: 'POST',
          url: `/skills/${auditSkillId}/restore`,
          payload: { version: 1 },
        }))
      ).statusCode,
    ).toBeLessThan(300);
    expect(
      (await send(app1, 'skill-delete', asSession(ada, { method: 'DELETE', url: `/skills/${auditSkillId}` }))).statusCode,
    ).toBeLessThan(300);

    // ── personal tokens: create (shown once), list, create + revoke ──────────
    const created = await send(
      app1,
      'token-create',
      asSession(bob, { method: 'POST', url: '/tokens', payload: { name: 'mcp laptop' } }),
    );
    expect(created.statusCode).toBe(201);
    const tok = created.json() as { id: string; token: string };
    bobToken = { id: tok.id, token: tok.token, authorization: `Bearer ${tok.token}` };
    sensitive.push({ what: 'api token (Bob)', value: tok.token, allowedIn: ['token-create'] });
    expect((await send(app1, 'token-list', asSession(bob, { method: 'GET', url: '/tokens' }))).statusCode).toBe(200);

    const spare = await send(
      app1,
      'token-create-2',
      asSession(bob, { method: 'POST', url: '/tokens', payload: { name: 'spare' } }),
    );
    const spareTok = spare.json() as { id: string; token: string };
    revokedTokenId = spareTok.id;
    sensitive.push({ what: 'api token (spare)', value: spareTok.token, allowedIn: ['token-create-2'] });
    const revoked = await send(app1, 'token-revoke', asSession(bob, { method: 'DELETE', url: `/tokens/${spareTok.id}` }));
    expect(revoked.statusCode).toBeLessThan(300);
    expect(
      (await send(app1, 'revoked-token-use', asToken({ authorization: `Bearer ${spareTok.token}`, token: spareTok.token }, { method: 'GET', url: '/repos' }))).statusCode,
    ).toBe(401);

    // ── a review run with the token (mock LLM), accept / dismiss ─────────────
    const name = `sec-scan-${rnd(4)}`;
    const [repo] = await app1.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    repoId = repo!.id;
    const [pr] = await app1.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 7,
        title: 'Add config',
        author: 'dev',
        branch: 'feat/x',
        base: 'main',
        headSha: 'abc123',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'needs_review',
        body: '',
      })
      .returning();
    await app1.db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
    });
    const [agent] = await app1.db
      .insert(t.agents)
      .values({ workspaceId, name: `Sec ${name}`, provider: 'openai', model: 'gpt-4.1', systemPrompt: 'sec' })
      .returning();

    const run = await send(
      app1,
      'review-run',
      asToken(bobToken, { method: 'POST', url: `/pulls/${pr!.id}/review`, payload: { agentId: agent!.id } }),
    );
    expect(run.statusCode).toBe(200);
    const runs = await waitForPrRuns(app1.db, pr!.id, { expected: 1 });
    runId = runs[0]!.id;
    expect(runs[0]!.status).toBe('done');

    const reviews = await send(app1, 'reviews', asToken(bobToken, { method: 'GET', url: `/pulls/${pr!.id}/reviews` }));
    const [review] = reviews.json() as Array<{ id: string; findings: Array<{ id: string }> }>;
    reviewId = review!.id;
    findingId = review!.findings[0]!.id;
    expect((await send(app1, 'trace', asSession(bob, { method: 'GET', url: `/runs/${runId}/trace` }))).statusCode).toBe(200);
    expect((await send(app1, 'runs', asSession(bob, { method: 'GET', url: `/pulls/${pr!.id}/runs` }))).statusCode).toBe(200);
    expect(
      (await send(app1, 'accept', asSession(bob, { method: 'POST', url: `/findings/${findingId}/accept` }))).statusCode,
    ).toBe(200);
    expect(
      (await send(app1, 'dismiss', asSession(ada, { method: 'POST', url: `/findings/${findingId}/dismiss` }))).statusCode,
    ).toBe(200);

    // ── destructive deletes (Admin) ────────────────────────────────────────────
    expect(
      (await send(app1, 'review-delete', asSession(ada, { method: 'DELETE', url: `/reviews/${reviewId}` }))).statusCode,
    ).toBeLessThan(300);
    expect(
      (await send(app1, 'run-delete', asSession(ada, { method: 'DELETE', url: `/runs/${runId}` }))).statusCode,
    ).toBeLessThan(300);

    // ── members: role change, deactivate (kills session + token), reactivate ──
    const patch = (label: string, payload: object) =>
      send(app1, label, asSession(ada, { method: 'PATCH', url: `/members/${bobId}`, payload }));
    expect((await patch('member-role', { role: 'admin' })).statusCode).toBe(200);
    expect((await patch('member-deactivate', { status: 'deactivated' })).statusCode).toBe(200);
    expect((await send(app1, 'dead-session', asSession(bob, { method: 'GET', url: '/members' }))).statusCode).toBe(401);
    expect((await send(app1, 'dead-token', asToken(bobToken, { method: 'GET', url: '/repos' }))).statusCode).toBe(401);
    expect((await patch('member-reactivate', { status: 'active' })).statusCode).toBe(200);

    // ── sign-out: the session is dead server-side ─────────────────────────────
    const signOutAda2 = await googleSignIn(app1, {
      subject: ADA_SUB,
      email: ADMIN_EMAIL,
      hostedDomain: 'onlytraf.com',
      name: 'Ada Admin',
    });
    const ada2 = signOutAda2.session!;
    expect(
      (await send(app1, 'sign-out', asSession(ada2, { method: 'POST', url: '/auth/sign-out' }))).statusCode,
    ).toBe(200);
    expect((await send(app1, 'after-sign-out', asSession(ada2, { method: 'GET', url: '/auth/session' }))).statusCode).toBe(
      401,
    );
  }, 60_000);

  it('AC-54: both SSE endpoints answer 401 JSON before any stream without a valid session or token', async () => {
    const bogus: SessionCredential = { cookie: `${SESSION_COOKIE}=${randomBytes(32).toString('base64url')}`, sessionId: 'x' };
    const bogusToken = `ddg_pat_${randomBytes(32).toString('base64url')}`;
    const signedOut = captured.find((c) => c.label === 'after-sign-out');
    expect(signedOut?.status).toBe(401);
    for (const url of [`/runs/${runId}/events`, `/repos/${repoId}/pulls/sync/events`]) {
      const attempts: Array<[string, InjectOptions]> = [
        ['no credentials', anonymous({ method: 'GET', url, headers: { accept: 'text/event-stream' } })],
        ['unknown cookie', asSession(bogus, { method: 'GET', url, headers: { accept: 'text/event-stream' } })],
        [
          'unknown bearer',
          asToken({ authorization: `Bearer ${bogusToken}`, token: bogusToken }, { method: 'GET', url }),
        ],
        // Deactivation revoked Bob's token; reactivation does not resurrect it.
        ['revoked token', asToken(bobToken, { method: 'GET', url })],
        ['spent session (deactivated)', asSession(bob, { method: 'GET', url })],
      ];
      for (const [why, opts] of attempts) {
        const res = await send(app1, `sse ${why} ${url}`, opts);
        expect(res.statusCode, `${why} ${url}`).toBe(401);
        expect(String(res.headers['content-type']), `${why} ${url}`).toMatch(/application\/json/);
        expect(res.payload).not.toContain('event:');
        expect(res.json().error?.code ?? res.json().code).toBe('unauthenticated');
      }
    }
  });

  it('master-key rotation on restart re-encrypts every row (secrets.reencrypt) and keys stay readable', async () => {
    await app1.close();
    const app2 = await buildGoogleApp({
      pg,
      env: env({
        SECRETS_MASTER_KEY: MASTER_2.toString('base64'),
        SECRETS_MASTER_KEY_PREVIOUS: MASTER_1.toString('base64'),
      }),
      bootChecks: true,
      logStream,
      overrides: overrides(),
    });
    try {
      const { session } = await googleSignIn(app2, {
        subject: ADA_SUB,
        email: ADMIN_EMAIL,
        hostedDomain: 'onlytraf.com',
        name: 'Ada Admin',
      });
      const status = await send(app2, 'secrets-status-after-rotation', asSession(session!, {
        method: 'GET',
        url: '/settings/secrets-status',
      }));
      const parsed = SecretsStatusDetailed.parse(status.json());
      for (const p of Object.keys(SECRET_VALUES) as (keyof typeof SECRET_VALUES)[]) {
        expect(parsed.states[p].state, p).toBe('set');
      }
      const ids = await app2.db.selectDistinct({ k: t.encryptedSecrets.keyId }).from(t.encryptedSecrets);
      expect(ids).toHaveLength(1);
    } finally {
      await app2.close();
    }
  }, 60_000);

  it('AC-52: every audited action of the scenario → exactly one row with actor / action / target / time', async () => {
    const db = pg.handle.db;
    const rows = await db.select().from(t.auditEvents).where(eq(t.auditEvents.workspaceId, workspaceId));
    const one = (action: string, actor: string | null, targetId?: string | null) => {
      const hits = rows.filter(
        (r) => r.action === action && (targetId === undefined || r.targetId === targetId),
      );
      expect(hits, `${action} ${targetId ?? ''}`).toHaveLength(1);
      const [row] = hits;
      expect(row!.actorUserId, action).toBe(actor);
      expect(row!.targetType, action).toBeTruthy();
      expect(row!.createdAt, action).toBeInstanceOf(Date);
      return row!;
    };

    // Sign-in: 3 successful for Ada in app1 (initial + re-sign-in) and app2; 1 Bob; 1 rejected; 1 sign-out.
    expect(rows.filter((r) => r.action === 'auth.sign_in' && r.actorUserId === adaId)).toHaveLength(3);
    expect(rows.filter((r) => r.action === 'auth.sign_in' && r.actorUserId === bobId)).toHaveLength(1);
    const rejected = one('auth.sign_in_rejected', null);
    expect(JSON.stringify(rejected.metadata)).toMatch(/evil\.example/); // the verified email is recorded
    one('auth.sign_out', adaId);

    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'GITLAB_TOKEN']) {
      one('secret.save', adaId, key);
    }
    one('settings.update', adaId);
    one('secrets.reencrypt', null);
    one('token.create', bobId, bobToken.id);
    one('token.revoke', bobId, revokedTokenId);
    one('finding.accept', bobId, findingId);
    one('finding.dismiss', adaId, findingId);
    one('review.delete', adaId, reviewId);
    one('run.delete', adaId, runId);
    one('member.role_change', adaId, bobId);
    one('member.deactivate', adaId, bobId);
    one('member.reactivate', adaId, bobId);

    // Route-driven descriptors (platform/auth/audit-hook.ts ← route-policy.ts).
    one('repo.add', adaId, addedRepoId);
    one('repo.remove', adaId, addedRepoId);
    one('agent.create', adaId, auditAgentId);
    one('agent.update', adaId, auditAgentId);
    expect(JSON.stringify(one('agent.promote', adaId, auditAgentId).metadata)).toContain('1');
    one('agent.delete', adaId, auditAgentId);
    one('skill.create', adaId, auditSkillId);
    one('skill.update', adaId, auditSkillId);
    one('skill.restore', adaId, auditSkillId);
    one('skill.delete', adaId, auditSkillId);

    // Secret saves carry the key NAME only; settings changes the changed key names only.
    for (const r of rows.filter((x) => x.action === 'secret.save')) {
      expect(Object.keys(r.metadata)).toEqual(['key_name']);
      expect(r.metadata.key_name).toBe(r.targetId);
    }
    const settingsRow = rows.find((r) => r.action === 'settings.update')!;
    expect(settingsRow.metadata).toEqual({ changed_keys: ['theme'] });
    const metaBlob = JSON.stringify(rows.map((r) => r.metadata));
    for (const s of sensitive) expect(metaBlob, s.what).not.toContain(s.value);

    // Spare token was created too (2 token.create for Bob in total).
    expect(rows.filter((r) => r.action === 'token.create' && r.actorUserId === bobId)).toHaveLength(2);
  });

  it('AC-37 / AC-52 / NFR logging: no sensitive value in the DB, the logs or any response', async () => {
    const db = pg.handle.db;
    expect(logs.length).toBeGreaterThan(50);
    expect(captured.length).toBeGreaterThan(40);

    // ---- DB dump: every text-like and bytea column of every base table ---------
    const cols = (await db.execute(sql`
      SELECT c.table_schema, c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY', 'bytea')
      ORDER BY 1, 2, 3
    `)) as unknown as Array<{ table_schema: string; table_name: string; column_name: string; data_type: string }>;
    const tables = new Set(cols.map((c) => c.table_name));
    for (const must of ['sessions', 'oauth_flows', 'api_tokens', 'encrypted_secrets', 'audit_events', 'run_traces', 'agent_runs', 'users', 'settings']) {
      expect(tables.has(must), must).toBe(true);
    }

    const dbText: string[] = [];
    const dbBytes: Buffer[] = [];
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    for (const c of cols) {
      const ref = `${q(c.table_schema)}.${q(c.table_name)}`;
      if (c.data_type === 'bytea') {
        const rows = (await db.execute(
          sql.raw(`SELECT ${q(c.column_name)} AS v FROM ${ref} WHERE ${q(c.column_name)} IS NOT NULL`),
        )) as unknown as Array<{ v: Buffer }>;
        for (const r of rows) {
          dbBytes.push(Buffer.from(r.v));
          dbText.push(Buffer.from(r.v).toString('latin1'), Buffer.from(r.v).toString('hex'));
        }
      } else {
        const rows = (await db.execute(
          sql.raw(`SELECT ${q(c.column_name)}::text AS v FROM ${ref} WHERE ${q(c.column_name)} IS NOT NULL`),
        )) as unknown as Array<{ v: string }>;
        for (const r of rows) dbText.push(`${c.table_name}.${c.column_name}=${r.v}`);
      }
    }
    const secretRows = await db.select().from(t.encryptedSecrets).where(eq(t.encryptedSecrets.workspaceId, workspaceId));
    expect(secretRows).toHaveLength(5);
    expect(dbBytes.length).toBeGreaterThanOrEqual(10); // ciphertext + nonce per row

    const dbBlob = dbText.join('\n');
    const logBlob = logs.join('\n');
    const findings: string[] = [];

    for (const s of sensitive) {
      for (const f of forms(s.value)) {
        if (dbBlob.includes(f)) {
          const where = dbText.find((x) => x.includes(f))!.split('=')[0];
          findings.push(`DB: ${s.what} in ${where}`);
        }
        if (logBlob.includes(f)) {
          const line = logs.find((l) => l.includes(f))!;
          findings.push(`LOG: ${s.what} in ${line.slice(0, 300).replace(f, '<HIT>')}`);
        }
        for (const c of captured) {
          if (s.allowedIn?.includes(c.label)) continue;
          if (c.headers.includes(f)) findings.push(`RESPONSE HEADERS [${c.label}]: ${s.what}`);
          if (c.body.includes(f)) findings.push(`RESPONSE BODY [${c.label}]: ${s.what}`);
        }
      }
      // Secret values must not be in ANY bytea either (plaintext bytes).
      for (const b of dbBytes) if (b.includes(Buffer.from(s.value))) findings.push(`DB bytea: ${s.what}`);
    }

    for (const [label, key] of [['master key (current)', MASTER_2], ['master key (previous)', MASTER_1]] as const) {
      for (const f of masterKeyForms(key)) {
        if (dbBlob.includes(f)) findings.push(`DB: ${label}`);
        if (logBlob.includes(f)) findings.push(`LOG: ${label}`);
        for (const c of captured) if (c.headers.includes(f) || c.body.includes(f)) findings.push(`RESPONSE [${c.label}]: ${label}`);
      }
      for (const b of dbBytes) if (b.includes(key)) findings.push(`DB bytea: ${label} (raw bytes)`);
    }

    expect(findings).toEqual([]);

    // Delivery responses really did carry their value (proves the scan sees them).
    const tokenCreate = captured.find((c) => c.label === 'token-create')!;
    expect(tokenCreate.body).toContain(bobToken.token);
    const firstCallback = captured.find((c) => c.label === 'callback#1')!;
    expect(firstCallback.headers).toContain(SESSION_COOKIE);

    // Positive controls: the dump and the log capture really cover the scenario.
    expect(dbBlob).toContain(`users.email=${ADMIN_EMAIL}`);
    expect(dbBlob).toContain('audit_events.action=secret.save');
    expect(dbBlob).toContain('encrypted_secrets.key_name=GITLAB_TOKEN');
    expect(logBlob).toContain('/auth/google/start');
    expect(logBlob).toContain('/settings/test-connection');
  });

  it('every OAuth flow row is single-use: none of the completed flows remains', async () => {
    const left = await pg.handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.oauthFlows);
    expect(left[0]!.n).toBe(0);
  });
  it('AC-66: a forged X-Forwarded-For from an untrusted peer changes neither the sign-in rate-limit key nor the audit ip', async () => {
    // TRUST_PROXY=127.0.0.1 (the helper's proxy address); the rate limiter is ON.
    const app3 = await buildGoogleApp({ pg, env: env(), rateLimit: true, logStream, overrides: overrides() });
    try {
      const UNTRUSTED = '198.51.100.9';
      const start = (remoteAddress: string, xff: string) =>
        app3.app.inject({
          method: 'GET',
          url: '/auth/google/start',
          remoteAddress,
          headers: { 'x-forwarded-for': xff, 'x-forwarded-proto': 'https' },
        });

      // Untrusted direct peer rotating forged XFF values: ONE bucket (its socket ip) → 21st is 429.
      const untrusted: number[] = [];
      for (let i = 0; i < 21; i++) untrusted.push((await start(UNTRUSTED, `203.0.113.${i + 1}`)).statusCode);
      expect(untrusted.slice(0, 20).every((c) => c !== 429)).toBe(true);
      expect(untrusted[20]).toBe(429);
      // The forged XFF is not trusted for the scheme either: no binding cookie over "plain HTTP".
      const plain = await start('198.51.100.10', '203.0.113.99');
      expect(plain.cookies.some((c) => c.name === OAUTH_BINDING_COOKIE)).toBe(false);

      // Control: via the trusted proxy, distinct real clients get separate budgets.
      const viaProxy: number[] = [];
      for (let i = 0; i < 25; i++) viaProxy.push((await start('127.0.0.1', `192.0.2.${i + 1}`)).statusCode);
      expect(viaProxy.every((c) => c === 302)).toBe(true);

      // Audit ip: an Admin mutation from the untrusted peer records the socket ip, not the forged one.
      const sess = await app3.signIn({ userId: adaId });
      const put = (remoteAddress: string, xff: string, theme: 'dark' | 'light') =>
        app3.app.inject({
          ...asSession(sess, { method: 'PUT', url: '/settings', payload: { theme }, headers: { 'x-forwarded-for': xff } }),
          remoteAddress,
        });
      const r1 = await put('198.51.100.20', '6.6.6.6', 'dark');
      expect(r1.statusCode).toBe(200);
      const r2 = await put('127.0.0.1', '192.0.2.200', 'light');
      expect(r2.statusCode).toBe(200);
      const audits = await pg.handle.db
        .select({ ip: t.auditEvents.ip, at: t.auditEvents.createdAt })
        .from(t.auditEvents)
        .where(eq(t.auditEvents.action, 'settings.update'));
      const ips = audits.map((a) => a.ip);
      expect(ips).toContain('198.51.100.20');
      expect(ips).toContain('192.0.2.200');
      expect(ips).not.toContain('6.6.6.6');
    } finally {
      await app3.close();
    }
  }, 60_000);
});
