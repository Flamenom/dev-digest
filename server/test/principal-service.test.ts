/**
 * T12 — PrincipalService (hermetic: fake repository + test clock; no Postgres).
 * AC-25 (idle 24 h / absolute 30 d), AC-27 (role re-read each call),
 * AC-56 (bearer tokens), fail-closed behaviour, bearer-wins-over-cookie.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@devdigest/shared';
import { newApiToken, newSessionId, sha256Hex } from '../src/platform/crypto/tokens.js';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  TOUCH_THROTTLE_MS,
} from '../src/modules/identity/constants.js';
import {
  PrincipalService,
  sessionCookieValue,
  type PrincipalRepository,
} from '../src/modules/identity/principal-service.js';

const T0 = new Date('2026-10-19T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface FakeSession {
  sessionId: string;
  idHash: string;
  userId: string;
  workspaceId: string;
  lastSeenAt: Date;
  expiresAt: Date;
}
interface FakeToken {
  tokenId: string;
  tokenHash: string;
  userId: string;
  workspaceId: string;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Mirrors the real repository semantics (role + status joined from the
 * membership on every lookup; idle / absolute / revoked / expired filters).
 */
class FakeRepo implements PrincipalRepository {
  sessionRows: FakeSession[] = [];
  tokenRows: FakeToken[] = [];
  members = new Map<string, { role: Role; status: 'active' | 'deactivated' }>();
  touches: string[] = [];
  lookups = 0;
  fail: Error | null = null;

  sessions: PrincipalRepository['sessions'] = {
    findActiveByHash: async (idHash, now) => {
      this.lookups++;
      if (this.fail) throw this.fail;
      const s = this.sessionRows.find((r) => r.idHash === idHash);
      if (!s) return undefined;
      const m = this.members.get(s.userId);
      if (!m || m.status !== 'active') return undefined;
      if (s.expiresAt.getTime() <= now.getTime()) return undefined;
      if (s.lastSeenAt.getTime() <= now.getTime() - SESSION_IDLE_MS) return undefined;
      return {
        sessionId: s.sessionId,
        userId: s.userId,
        workspaceId: s.workspaceId,
        role: m.role,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
      };
    },
    touch: async (sessionId, at) => {
      this.touches.push(`session:${sessionId}`);
      const s = this.sessionRows.find((r) => r.sessionId === sessionId);
      if (s) s.lastSeenAt = at;
    },
  };

  apiTokens: PrincipalRepository['apiTokens'] = {
    findActiveByHash: async (tokenHash, now) => {
      this.lookups++;
      if (this.fail) throw this.fail;
      const t = this.tokenRows.find((r) => r.tokenHash === tokenHash);
      if (!t || t.revokedAt || t.expiresAt.getTime() <= now.getTime()) return undefined;
      const m = this.members.get(t.userId);
      if (!m || m.status !== 'active') return undefined;
      return {
        tokenId: t.tokenId,
        userId: t.userId,
        workspaceId: t.workspaceId,
        role: m.role,
        lastUsedAt: t.lastUsedAt,
      };
    },
    touch: async (tokenId, at) => {
      this.touches.push(`token:${tokenId}`);
      const t = this.tokenRows.find((r) => r.tokenId === tokenId);
      if (t) t.lastUsedAt = at;
    },
  };

  addSession(userId: string, at: Date): string {
    const value = newSessionId();
    this.sessionRows.push({
      sessionId: `s-${this.sessionRows.length + 1}`,
      idHash: sha256Hex(value),
      userId,
      workspaceId: 'ws-1',
      lastSeenAt: at,
      expiresAt: new Date(at.getTime() + SESSION_ABSOLUTE_MS),
    });
    return value;
  }

  addToken(userId: string, expiresAt: Date): { value: string; row: FakeToken } {
    const tok = newApiToken();
    const row: FakeToken = {
      tokenId: `t-${this.tokenRows.length + 1}`,
      tokenHash: tok.hash,
      userId,
      workspaceId: 'ws-1',
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    };
    this.tokenRows.push(row);
    return { value: tok.value, row };
  }
}

class TestClock {
  constructor(public t: Date) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

let repo: FakeRepo;
let clock: TestClock;
let service: PrincipalService;

beforeEach(() => {
  repo = new FakeRepo();
  repo.members.set('u-admin', { role: 'admin', status: 'active' });
  repo.members.set('u-member', { role: 'member', status: 'active' });
  clock = new TestClock(T0);
  service = new PrincipalService({ repo, clock });
});

const withCookie = (value: string, extra = '') => ({
  headers: { cookie: `theme=dark; ${SESSION_COOKIE}=${value}${extra}` },
});
const withBearer = (value: string, cookie?: string) => ({
  headers: {
    authorization: `Bearer ${value}`,
    ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
  },
});

describe('PrincipalService — sessions', () => {
  it('resolves a fresh session cookie to the user, via session', async () => {
    const value = repo.addSession('u-admin', T0);
    const p = await service.resolve(withCookie(value));
    expect(p).toEqual({ userId: 'u-admin', workspaceId: 'ws-1', role: 'admin', via: 'session', sessionId: 's-1' });
  });

  it('no cookie / unknown cookie / other cookies only → null', async () => {
    expect(await service.resolve({ headers: {} })).toBeNull();
    expect(await service.resolve({ headers: { cookie: 'theme=dark' } })).toBeNull();
    expect(await service.resolve(withCookie('not-a-session'))).toBeNull();
  });

  it('ends a session 24 h + 1 s after the last activity (AC-25 idle)', async () => {
    const value = repo.addSession('u-member', T0);
    clock.advance(SESSION_IDLE_MS + 1000);
    expect(await service.resolve(withCookie(value))).toBeNull();
  });

  it('a session used every 23 h still ends at day 30 (AC-25 absolute)', async () => {
    const value = repo.addSession('u-member', T0);
    let last: unknown = null;
    while (clock.t.getTime() + 23 * HOUR < T0.getTime() + SESSION_ABSOLUTE_MS) {
      clock.advance(23 * HOUR);
      last = await service.resolve(withCookie(value));
      expect(last).not.toBeNull();
    }
    clock.t = new Date(T0.getTime() + 30 * DAY);
    expect(await service.resolve(withCookie(value))).toBeNull();
  });

  it('enforces idle/absolute even if the repository returned a stale row', async () => {
    const stale: PrincipalRepository = {
      ...repo,
      sessions: {
        findActiveByHash: async () => ({
          sessionId: 's-x',
          userId: 'u-admin',
          workspaceId: 'ws-1',
          role: 'admin',
          lastSeenAt: new Date(T0.getTime() - SESSION_IDLE_MS - 1),
          expiresAt: new Date(T0.getTime() + DAY),
        }),
        touch: async () => {},
      },
      apiTokens: repo.apiTokens,
    };
    const svc = new PrincipalService({ repo: stale, clock });
    expect(await svc.resolve(withCookie('x'))).toBeNull();
  });

  it('touches last_seen_at at most once per throttle window', async () => {
    const value = repo.addSession('u-member', T0);
    await service.resolve(withCookie(value)); // lastSeenAt == now → no touch
    clock.advance(TOUCH_THROTTLE_MS - 1);
    await service.resolve(withCookie(value));
    expect(repo.touches).toEqual([]);
    clock.advance(1);
    await service.resolve(withCookie(value));
    await service.resolve(withCookie(value));
    expect(repo.touches).toEqual(['session:s-1']);
  });

  it('re-reads role and status on every call (AC-27)', async () => {
    const value = repo.addSession('u-admin', T0);
    expect((await service.resolve(withCookie(value)))?.role).toBe('admin');
    repo.members.set('u-admin', { role: 'member', status: 'active' });
    expect((await service.resolve(withCookie(value)))?.role).toBe('member');
    repo.members.set('u-admin', { role: 'member', status: 'deactivated' });
    expect(await service.resolve(withCookie(value))).toBeNull();
    expect(repo.lookups).toBe(3);
  });
});

describe('PrincipalService — bearer tokens (AC-56)', () => {
  it("authenticates as the owner with the owner's CURRENT role", async () => {
    const { value } = repo.addToken('u-member', new Date(T0.getTime() + 90 * DAY));
    expect(await service.resolve(withBearer(value))).toEqual({
      userId: 'u-member',
      workspaceId: 'ws-1',
      role: 'member',
      via: 'token',
      tokenId: 't-1',
    });
    repo.members.set('u-member', { role: 'admin', status: 'active' });
    expect((await service.resolve(withBearer(value)))?.role).toBe('admin');
  });

  it('expired, revoked and deactivated-owner tokens → null', async () => {
    const expired = repo.addToken('u-member', new Date(T0.getTime() + DAY));
    const revoked = repo.addToken('u-member', new Date(T0.getTime() + 90 * DAY));
    revoked.row.revokedAt = T0;
    const orphan = repo.addToken('u-admin', new Date(T0.getTime() + 90 * DAY));
    repo.members.set('u-admin', { role: 'admin', status: 'deactivated' });
    clock.advance(DAY);
    expect(await service.resolve(withBearer(expired.value))).toBeNull();
    expect(await service.resolve(withBearer(revoked.value))).toBeNull();
    expect(await service.resolve(withBearer(orphan.value))).toBeNull();
  });

  it('touches last_used_at on first use, then throttled', async () => {
    const { value } = repo.addToken('u-member', new Date(T0.getTime() + 90 * DAY));
    await service.resolve(withBearer(value));
    await service.resolve(withBearer(value));
    clock.advance(TOUCH_THROTTLE_MS);
    await service.resolve(withBearer(value));
    expect(repo.touches).toEqual(['token:t-1', 'token:t-1']);
  });

  it('bearer wins over the cookie — an invalid bearer does NOT fall back to the session', async () => {
    const session = repo.addSession('u-admin', T0);
    const { value } = repo.addToken('u-member', new Date(T0.getTime() + 90 * DAY));
    expect((await service.resolve(withBearer(value, session)))?.via).toBe('token');
    expect((await service.resolve(withBearer(value, session)))?.userId).toBe('u-member');
    expect(await service.resolve(withBearer('ddg_pat_unknown', session))).toBeNull();
  });

  it('malformed bearer values are rejected without a lookup', async () => {
    const session = repo.addSession('u-admin', T0);
    for (const header of ['Bearer', 'Bearer ', 'Bearer not-our-prefix', 'Bearer a b', `Bearer ddg_pat_${'x'.repeat(600)}`]) {
      const before = repo.lookups;
      expect(
        await service.resolve({ headers: { authorization: header, cookie: `${SESSION_COOKIE}=${session}` } }),
      ).toBeNull();
      expect(repo.lookups).toBe(before);
    }
  });

  it('a non-Bearer Authorization scheme is ignored (cookie still applies)', async () => {
    const session = repo.addSession('u-admin', T0);
    const p = await service.resolve({ headers: { authorization: 'Basic Zm9vOmJhcg==', cookie: `${SESSION_COOKIE}=${session}` } });
    expect(p?.via).toBe('session');
  });
});

describe('PrincipalService — fail closed', () => {
  it('a repository failure propagates instead of resolving anonymously', async () => {
    const session = repo.addSession('u-admin', T0);
    const { value } = repo.addToken('u-member', new Date(T0.getTime() + 90 * DAY));
    repo.fail = new Error('db down');
    await expect(service.resolve(withCookie(session))).rejects.toThrow('db down');
    await expect(service.resolve(withBearer(value))).rejects.toThrow('db down');
  });

  it('a failing touch propagates too', async () => {
    const session = repo.addSession('u-admin', T0);
    repo.sessions.touch = async () => {
      throw new Error('write failed');
    };
    clock.advance(TOUCH_THROTTLE_MS);
    await expect(service.resolve(withCookie(session))).rejects.toThrow('write failed');
  });
});

describe('sessionCookieValue', () => {
  it('extracts only the session cookie, verbatim', () => {
    expect(sessionCookieValue(withCookie('abc_-123', '; other=1'))).toBe('abc_-123');
    expect(sessionCookieValue({ headers: { cookie: `x${SESSION_COOKIE}=evil` } })).toBeUndefined();
    expect(sessionCookieValue({ headers: { cookie: `${SESSION_COOKIE}=` } })).toBeUndefined();
    expect(sessionCookieValue({ headers: {} })).toBeUndefined();
  });
});
