/**
 * T9 — Google OIDC adapter (hermetic: injected fetch + jose-generated keys;
 * no network). AC-7 (PKCE / state / nonce in the URL), AC-8 (verification),
 * AC-15 (IdP unavailable).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import {
  GoogleIdentityProvider,
  GOOGLE_JWKS_URI,
  GOOGLE_TOKEN_ENDPOINT,
  type FetchLike,
} from '../src/adapters/oidc/index.js';
import { MockIdentityProvider } from '../src/adapters/mocks.js';
import { AuthFlowError } from '../src/platform/auth-errors.js';
import { codeChallengeS256, codeVerifier } from '../src/platform/crypto/tokens.js';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-super-secret-value';
const REDIRECT_URI = 'https://devdigest.example/api/auth/google/callback';
const NONCE = 'nonce-abc';
const CODE = '4/0Acode-very-secret';

type Key = { privateKey: CryptoKey; jwk: JWK };

async function makeKey(kid: string): Promise<Key> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk };
}

let keyA: Key;
let keyB: Key;
let keyC: Key;
let rogue: Key; // same kid as A, different key material → bad signature

beforeAll(async () => {
  [keyA, keyB, keyC] = await Promise.all([makeKey('kid-a'), makeKey('kid-b'), makeKey('kid-c')]);
  rogue = await makeKey('kid-a');
});

afterEach(() => {
  vi.useRealTimers();
});

interface SignOpts {
  key?: Key;
  claims?: Record<string, unknown>;
  iss?: string;
  aud?: string;
  /** exp relative to now, seconds. */
  expIn?: number;
}

async function sign(opts: SignOpts = {}): Promise<string> {
  const key = opts.key ?? keyA;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: 'alice@onlytraf.com',
    email_verified: true,
    hd: 'onlytraf.com',
    name: 'Alice',
    picture: 'https://lh3.googleusercontent.com/a/x',
    nonce: NONCE,
    ...opts.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.jwk.kid! })
    .setSubject('1234567890')
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? CLIENT_ID)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (opts.expIn ?? 3600))
    .sign(key.privateKey);
}

/** Stub of Google's endpoints. `jwks` is mutable so a test can rotate keys. */
function stubGoogle() {
  const state = {
    jwks: [keyA.jwk] as JWK[],
    jwksStatus: 200,
    jwksFetches: 0,
    tokenRequests: [] as { body: string }[],
    tokenResponse: (): Response | Promise<Response> =>
      new Response(JSON.stringify({ id_token: 'the-id-token', access_token: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === GOOGLE_JWKS_URI) {
      state.jwksFetches += 1;
      return new Response(JSON.stringify({ keys: state.jwks }), { status: state.jwksStatus });
    }
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      state.tokenRequests.push({ body: String(init?.body ?? '') });
      return state.tokenResponse();
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { state, fetchImpl };
}

function makeIdp(fetchImpl: FetchLike) {
  return new GoogleIdentityProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    hostedDomain: 'onlytraf.com',
    fetch: fetchImpl,
  });
}

async function flowCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AuthFlowError);
    const e = err as AuthFlowError;
    // No secret material ever leaks into the error.
    const dump = `${e.message} ${JSON.stringify(e.details ?? null)} ${String(e.stack)}`;
    expect(dump).not.toContain(CLIENT_SECRET);
    expect(dump).not.toContain(CODE);
    expect((e as { cause?: unknown }).cause).toBeUndefined();
    return e.flowCode;
  }
  throw new Error('expected an AuthFlowError');
}

describe('GoogleIdentityProvider.authorizationUrl (AC-7)', () => {
  it('builds a PKCE S256 code-flow URL with state, nonce and the hd hint', () => {
    const { fetchImpl } = stubGoogle();
    const verifier = codeVerifier();
    const challenge = codeChallengeS256(verifier);
    const url = new URL(
      makeIdp(fetchImpl).authorizationUrl({ state: 'st-1', nonce: NONCE, codeChallenge: challenge }),
    );
    expect(url.origin).toBe('https://accounts.google.com');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('state')).toBe('st-1');
    expect(q.get('nonce')).toBe(NONCE);
    expect(q.get('code_challenge')).toBe(challenge);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('hd')).toBe('onlytraf.com');
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    expect(url.toString()).not.toContain(verifier);
  });
});

describe('GoogleIdentityProvider.exchangeCode (AC-15)', () => {
  it('posts code + verifier + client credentials and returns the id_token', async () => {
    const { state, fetchImpl } = stubGoogle();
    const res = await makeIdp(fetchImpl).exchangeCode({ code: CODE, codeVerifier: 'ver-1' });
    expect(res).toEqual({ idToken: 'the-id-token' });
    const body = new URLSearchParams(state.tokenRequests[0]!.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe(CODE);
    expect(body.get('code_verifier')).toBe('ver-1');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('maps a 503, a 400, a network error and a missing id_token to auth_idp_unavailable', async () => {
    const { state, fetchImpl } = stubGoogle();
    const idp = makeIdp(fetchImpl);
    const input = { code: CODE, codeVerifier: 'ver-1' };

    state.tokenResponse = () => new Response('unavailable', { status: 503 });
    expect(await flowCode(idp.exchangeCode(input))).toBe('auth_idp_unavailable');

    state.tokenResponse = () =>
      new Response(JSON.stringify({ error: 'invalid_grant', code: CODE }), { status: 400 });
    expect(await flowCode(idp.exchangeCode(input))).toBe('auth_idp_unavailable');

    state.tokenResponse = () => {
      throw new TypeError(`fetch failed (secret=${CLIENT_SECRET} code=${CODE})`);
    };
    expect(await flowCode(idp.exchangeCode(input))).toBe('auth_idp_unavailable');

    state.tokenResponse = () => new Response(JSON.stringify({ access_token: 'x' }), { status: 200 });
    expect(await flowCode(idp.exchangeCode(input))).toBe('auth_idp_unavailable');

    const err = new AuthFlowError('auth_idp_unavailable');
    expect(err.statusCode).toBe(502);
  });
});

describe('GoogleIdentityProvider.verifyIdToken (AC-8)', () => {
  it('returns the identity built from verified claims', async () => {
    const { fetchImpl } = stubGoogle();
    const identity = await makeIdp(fetchImpl).verifyIdToken({ idToken: await sign(), nonce: NONCE });
    expect(identity).toEqual({
      subject: '1234567890',
      email: 'alice@onlytraf.com',
      emailVerified: true,
      hostedDomain: 'onlytraf.com',
      name: 'Alice',
      avatarUrl: 'https://lh3.googleusercontent.com/a/x',
    });
  });

  it('accepts the bare "accounts.google.com" issuer and reports absent hd / unverified email', async () => {
    const { fetchImpl } = stubGoogle();
    const token = await sign({
      iss: 'accounts.google.com',
      claims: { hd: undefined, email: 'x@gmail.com', email_verified: false },
    });
    const identity = await makeIdp(fetchImpl).verifyIdToken({ idToken: token, nonce: NONCE });
    expect(identity.hostedDomain).toBeUndefined();
    expect(identity.emailVerified).toBe(false);
    expect(identity.email).toBe('x@gmail.com');
  });

  it.each([
    ['bad signature', () => sign({ key: rogue })],
    ['wrong aud', () => sign({ aud: 'someone-else.apps.googleusercontent.com' })],
    ['wrong iss', () => sign({ iss: 'https://evil.example.com' })],
    ['exp 61 s in the past', () => sign({ expIn: -61 })],
    ['missing nonce', () => sign({ claims: { nonce: undefined } })],
    ['missing email', () => sign({ claims: { email: undefined } })],
  ])('rejects %s with auth_token_invalid', async (_label, make) => {
    const { fetchImpl } = stubGoogle();
    const idToken = await make();
    expect(await flowCode(makeIdp(fetchImpl).verifyIdToken({ idToken, nonce: NONCE }))).toBe(
      'auth_token_invalid',
    );
  });

  it('rejects a wrong nonce and garbage input with auth_token_invalid', async () => {
    const { fetchImpl } = stubGoogle();
    const idp = makeIdp(fetchImpl);
    const idToken = await sign();
    expect(await flowCode(idp.verifyIdToken({ idToken, nonce: 'other-nonce' }))).toBe(
      'auth_token_invalid',
    );
    expect(await flowCode(idp.verifyIdToken({ idToken, nonce: '' }))).toBe('auth_token_invalid');
    expect(await flowCode(idp.verifyIdToken({ idToken: 'not.a.jwt', nonce: NONCE }))).toBe(
      'auth_token_invalid',
    );
  });

  it('tolerates up to 60 s of clock skew on exp', async () => {
    const { fetchImpl } = stubGoogle();
    const idToken = await sign({ expIn: -30 });
    await expect(makeIdp(fetchImpl).verifyIdToken({ idToken, nonce: NONCE })).resolves.toMatchObject({
      subject: '1234567890',
    });
  });

  it('maps a JWKS outage (5xx or network error) to auth_idp_unavailable', async () => {
    const down = stubGoogle();
    down.state.jwksStatus = 503;
    expect(
      await flowCode(makeIdp(down.fetchImpl).verifyIdToken({ idToken: await sign(), nonce: NONCE })),
    ).toBe('auth_idp_unavailable');

    const offline: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(
      await flowCode(makeIdp(offline).verifyIdToken({ idToken: await sign(), nonce: NONCE })),
    ).toBe('auth_idp_unavailable');
  });

  it('refetches the JWKS at most once per 60 s on an unknown kid', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
    const { state, fetchImpl } = stubGoogle();
    const idp = makeIdp(fetchImpl);

    await idp.verifyIdToken({ idToken: await sign(), nonce: NONCE });
    expect(state.jwksFetches).toBe(1);

    // Google rotates in kid-b. Within the 60 s cooldown an unknown kid does
    // NOT trigger a refetch and is rejected.
    state.jwks = [keyA.jwk, keyB.jwk];
    vi.setSystemTime(new Date('2026-10-19T10:00:30Z'));
    expect(
      await flowCode(idp.verifyIdToken({ idToken: await sign({ key: keyB }), nonce: NONCE })),
    ).toBe('auth_token_invalid');
    expect(state.jwksFetches).toBe(1);

    // After the cooldown: exactly one refetch, and kid-b now verifies.
    vi.setSystemTime(new Date('2026-10-19T10:01:01Z'));
    await expect(
      idp.verifyIdToken({ idToken: await sign({ key: keyB }), nonce: NONCE }),
    ).resolves.toMatchObject({ subject: '1234567890' });
    expect(state.jwksFetches).toBe(2);

    // A still-unknown kid right after that refetch → no further fetch.
    expect(
      await flowCode(idp.verifyIdToken({ idToken: await sign({ key: keyC }), nonce: NONCE })),
    ).toBe('auth_token_invalid');
    expect(state.jwksFetches).toBe(2);
  });
});

describe('MockIdentityProvider', () => {
  it('scripts identities, enforces issued nonces, simulates failures and records calls', async () => {
    const idp = new MockIdentityProvider().scriptCode('code-bob', { email: 'bob@onlytraf.com' });
    const url = new URL(idp.authorizationUrl({ state: 's', nonce: 'n1', codeChallenge: 'c' }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const { idToken } = await idp.exchangeCode({ code: 'code-bob', codeVerifier: 'v' });
    expect((await idp.verifyIdToken({ idToken, nonce: 'n1' })).email).toBe('bob@onlytraf.com');
    expect(await flowCode(idp.verifyIdToken({ idToken, nonce: 'never-issued' }))).toBe(
      'auth_token_invalid',
    );

    idp.fail('bad_token');
    expect(await flowCode(idp.verifyIdToken({ idToken, nonce: 'n1' }))).toBe('auth_token_invalid');
    idp.fail('idp_down');
    expect(await flowCode(idp.exchangeCode({ code: 'x', codeVerifier: 'v' }))).toBe(
      'auth_idp_unavailable',
    );
    idp.fail(null);

    expect(idp.calls.map((c) => c.kind)).toEqual([
      'authorizationUrl',
      'exchangeCode',
      'verifyIdToken',
      'verifyIdToken',
      'verifyIdToken',
      'exchangeCode',
    ]);
    expect(idp.callsOf('exchangeCode')[0]!.input.code).toBe('code-bob');
  });
});
