import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { scrubEvent, scrubString } from '../src/platform/sentry-scrub.js';

/**
 * Canary matrix (AC-36/37/38): every canary class is placed in every event
 * location in the form it would naturally take there; the serialized scrubbed
 * event must contain none of them.
 */
const C = {
  auth: 'AUTHCANARYbearer0123456789',
  session: 'SESSIONCANARY_abcdefghijklmnop',
  pat: `ddg_pat_${'P'.repeat(10)}patcanary_xyz`,
  github: `ghp_${'G'.repeat(20)}ghcanary1234567`,
  githubFine: `github_pat_${'F'.repeat(22)}finecanary`,
  gitlab: `glpat-${'L'.repeat(16)}glcanary`,
  openai: `sk-proj-${'O'.repeat(12)}oaicanary`,
  master: randomBytes(32).toString('base64'),
  googleSecret: 'GOCSPX-googlesecretcanary42',
  jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlY2FuYXJ5',
  code: 'OAUTHCODECANARY4242',
  state: 'OAUTHSTATECANARY4242',
  dbPassword: 'DbPassCanary!2026',
  backupPassword: 'BackupPassCanary_77',
} as const;

const SECRETS = [C.master, C.googleSecret, C.dbPassword, C.backupPassword];

/** All canaries in their natural textual form. */
const carrier = [
  `Authorization: Bearer ${C.auth}`,
  `Cookie: __Host-ddg_session=${C.session}; theme=dark`,
  `token ${C.pat}`,
  `gh ${C.github} ${C.githubFine}`,
  `gl ${C.gitlab}`,
  `llm ${C.openai}`,
  `master ${C.master}`,
  `google ${C.googleSecret}`,
  `id_token ${C.jwt}`,
  `cb https://dd.example.com/api/auth/callback?code=${C.code}&state=${C.state}`,
  `db postgres://devdigest:${C.dbPassword}@db:5432/devdigest`,
  `backup pw ${C.backupPassword}`,
].join(' | ');

function canaryEvent() {
  return {
    event_id: 'e1',
    message: `message: ${carrier}`,
    transaction: `/api/auth/callback?code=${C.code}&state=${C.state}`,
    exception: {
      values: [
        {
          type: 'Error',
          value: `git clone https://x:${C.github}@github.com/o/r failed: ${carrier}`,
          stacktrace: { frames: [{ function: 'f', vars: { token: C.pat, other: carrier } }] },
        },
      ],
    },
    request: {
      method: 'POST',
      url: `https://dd.example.com/api/auth/callback?code=${C.code}&state=${C.state}`,
      query_string: `code=${C.code}&state=${C.state}`,
      data: { password: C.dbPassword, body: carrier },
      cookies: { '__Host-ddg_session': C.session },
      env: { REMOTE_ADDR: '10.0.0.1' },
      headers: {
        Authorization: `Bearer ${C.auth}`,
        Cookie: `__Host-ddg_session=${C.session}`,
        'Set-Cookie': `__Host-ddg_session=${C.session}; Path=/`,
        'X-Debug': carrier,
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/json',
      },
    },
    user: { id: 'user-123', email: 'alice@example.com', username: 'Alice', ip_address: '1.2.3.4' },
    breadcrumbs: [{ message: carrier, data: { url: `https://x/cb?code=${C.code}` } }],
    extra: {
      note: carrier,
      token: C.pat,
      apiKey: C.openai,
      nested: { deep: [carrier], session: C.session },
    },
    contexts: {
      app: { detail: carrier, authHeader: `Bearer ${C.auth}` },
      oauth: { code: C.code, state: C.state },
    },
    tags: { route: '/api/auth/callback', hint: carrier, secret: C.googleSecret },
  };
}

describe('scrubEvent — canary matrix', () => {
  it('leaves no canary anywhere in the serialized event', () => {
    const out = JSON.stringify(scrubEvent(canaryEvent(), SECRETS));
    for (const [name, value] of Object.entries(C)) {
      expect(out.includes(value), `canary ${name} leaked`).toBe(false);
    }
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('1.2.3.4');
    expect(out).not.toContain('10.0.0.1');
  });

  it('drops request body, cookies, query, breadcrumbs; allowlists headers', () => {
    const out = scrubEvent(canaryEvent(), SECRETS);
    expect(out.breadcrumbs).toBeUndefined();
    expect(out.request).not.toHaveProperty('data');
    expect(out.request).not.toHaveProperty('cookies');
    expect(out.request).not.toHaveProperty('query_string');
    expect(out.request).not.toHaveProperty('env');
    expect(out.request?.url).toBe('https://dd.example.com/api/auth/callback');
    expect(out.request?.headers).toEqual({
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/json',
    });
    expect(out.transaction).toBe('/api/auth/callback');
    expect(out.tags).toEqual(expect.objectContaining({ route: '/api/auth/callback' }));
    expect(out.tags).not.toHaveProperty('secret');
    expect(out.extra).not.toHaveProperty('token');
    expect(out.contexts).not.toHaveProperty('oauth');
    expect(JSON.stringify(out.exception)).not.toContain('"vars"');
  });

  it('keeps only user.id (AC-38)', () => {
    expect(scrubEvent(canaryEvent(), SECRETS).user).toEqual({ id: 'user-123' });
  });

  it('redacts URL userinfo in the exception message (AC-37)', () => {
    const out = scrubEvent(
      { exception: { values: [{ type: 'Error', value: 'fetch https://x:TOKENVALUE@gitlab.com/a failed' }] } },
      [],
    );
    expect(out.exception?.values?.[0]?.value).toBe('fetch https://***@gitlab.com/a failed');
  });

  it('does not mutate its input', () => {
    const e = canaryEvent();
    const before = JSON.stringify(e);
    scrubEvent(e, SECRETS);
    expect(JSON.stringify(e)).toBe(before);
  });

  it('scrubString masks literal secrets and token shapes', () => {
    expect(scrubString(`a ${C.dbPassword} b ${C.gitlab}`, [C.dbPassword])).toBe('a *** b ***');
  });
});
