/**
 * T12 — SignInService (hermetic: in-memory fake repository + audit, MockIdentityProvider,
 * fixed clock; no Postgres). AC-7, AC-9 … AC-15, AC-17, AC-18, AC-24, AC-52 service halves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditEventInput, Role, MemberStatus } from '@devdigest/shared';
import { MockIdentityProvider } from '../src/adapters/mocks.js';
import { AuthFlowError } from '../src/platform/auth-errors.js';
import { sha256Hex } from '../src/platform/crypto/tokens.js';
import { OAUTH_FLOW_TTL_MS } from '../src/modules/identity/constants.js';
import {
  SignInService,
  type SignInRepository,
} from '../src/modules/identity/sign-in-service.js';
import type {
  IdentityTx,
  IdentityUser,
  Membership,
  NewOAuthFlow,
  OAuthFlow,
  UserClaims,
} from '../src/modules/identity/repository.js';

const WS = 'ws-1';
const T0 = new Date('2026-10-19T10:00:00.000Z');

// ---------------------------------------------------------------------------
// In-memory fake of the identity repository slice. Writes made inside
// `withWorkspaceLock` are applied to a snapshot and only committed when the
// callback resolves — a throw rolls them back, like the real transaction.
// ---------------------------------------------------------------------------
interface State {
  users: IdentityUser[];
  memberships: Membership[];
  sessions: { idHash: string; userId: string; workspaceId: string; createdAt: Date }[];
  flows: Map<string, OAuthFlow>;
}

function clone(s: State): State {
  return {
    users: s.users.map((u) => ({ ...u })),
    memberships: s.memberships.map((m) => ({ ...m })),
    sessions: s.sessions.map((x) => ({ ...x })),
    flows: new Map(s.flows),
  };
}

class FakeRepo implements SignInRepository {
  state: State = { users: [], memberships: [], sessions: [], flows: new Map() };
  writes: string[] = [];
  private active: State | null = null;
  private seq = 0;
  upsertError: unknown = null;

  private get s(): State {
    return this.active ?? this.state;
  }

  users: SignInRepository['users'] = {
    findBySub: async (subject) => this.s.users.find((u) => u.googleSub === subject),
    upsertBySub: async (claims: UserClaims, now: Date) => {
      this.writes.push('users.upsertBySub');
      if (this.upsertError) throw this.upsertError;
      const existing = this.s.users.find((u) => u.googleSub === claims.subject);
      if (existing) {
        Object.assign(existing, {
          email: claims.email,
          name: claims.name,
          avatarUrl: claims.avatarUrl,
          lastSignInAt: now,
        });
        return { user: { ...existing }, created: false };
      }
      const user: IdentityUser = {
        id: `user-${++this.seq}`,
        email: claims.email,
        name: claims.name,
        avatarUrl: claims.avatarUrl,
        googleSub: claims.subject,
        createdAt: now,
        lastSignInAt: now,
      };
      this.s.users.push(user);
      return { user: { ...user }, created: true };
    },
  };

  memberships: SignInRepository['memberships'] = {
    get: async (ws, userId) => this.s.memberships.find((m) => m.workspaceId === ws && m.userId === userId),
    ensureMember: async (ws, userId, role, now) => {
      this.writes.push('memberships.ensureMember');
      const existing = this.s.memberships.find((m) => m.workspaceId === ws && m.userId === userId);
      if (existing) return { membership: { ...existing }, created: false };
      const m: Membership = {
        workspaceId: ws,
        userId,
        role,
        status: 'active',
        statusChangedAt: null,
        statusChangedBy: null,
        joinedAt: now,
      };
      this.s.memberships.push(m);
      return { membership: { ...m }, created: true };
    },
    countActiveAdmins: async (ws) =>
      this.s.memberships.filter(
        (m) =>
          m.workspaceId === ws &&
          m.role === 'admin' &&
          m.status === 'active' &&
          this.s.users.find((u) => u.id === m.userId)?.googleSub != null,
      ).length,
    setRole: async (ws, userId, role) => {
      this.writes.push('memberships.setRole');
      const m = this.s.memberships.find((x) => x.workspaceId === ws && x.userId === userId);
      if (!m) return undefined;
      m.role = role;
      return { ...m };
    },
  };

  sessions: SignInRepository['sessions'] = {
    create: async (input) => {
      this.writes.push('sessions.create');
      this.s.sessions.push({
        idHash: input.idHash,
        userId: input.userId,
        workspaceId: input.workspaceId,
        createdAt: input.now,
      });
      return {
        id: `session-${++this.seq}`,
        userId: input.userId,
        workspaceId: input.workspaceId,
        createdAt: input.now,
        lastSeenAt: input.now,
        expiresAt: new Date(input.now.getTime() + 30 * 86_400_000),
      };
    },
    deleteByHash: async (idHash) => {
      this.writes.push('sessions.deleteByHash');
      const before = this.s.sessions.length;
      this.s.sessions = this.s.sessions.filter((x) => x.idHash !== idHash);
      return this.s.sessions.length < before;
    },
  };

  oauthFlows: SignInRepository['oauthFlows'] = {
    create: async (input: NewOAuthFlow) => {
      this.state.flows.set(input.stateHash, {
        bindingHash: input.bindingHash,
        nonce: input.nonce,
        codeVerifier: input.codeVerifier,
        returnTo: input.returnTo,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + OAUTH_FLOW_TTL_MS),
      });
    },
    // Mirrors the SQL: `DELETE … WHERE state_hash = $1 AND binding_hash = $2` —
    // a wrong binding matches (and deletes) nothing.
    consume: async (stateHash: string, bindingHash: string, now: Date) => {
      const flow = this.state.flows.get(stateHash);
      if (!flow || flow.bindingHash !== bindingHash) return undefined;
      this.state.flows.delete(stateHash);
      if (flow.expiresAt.getTime() <= now.getTime()) return undefined;
      return flow;
    },
  };

  withWorkspaceLock = async <T>(_ws: string, fn: (tx: IdentityTx) => Promise<T>): Promise<T> => {
    this.active = clone(this.state);
    try {
      const out = await fn({} as IdentityTx);
      this.state = { ...this.active, flows: this.state.flows };
      return out;
    } finally {
      this.active = null;
    }
  };

  /** Identity-table writes (sessions / users / memberships), excluding flow bookkeeping. */
  identityWrites(): string[] {
    return this.writes;
  }

  seedMember(opts: { sub: string | null; email: string; role: Role; status?: MemberStatus }): IdentityUser {
    const user: IdentityUser = {
      id: `user-${++this.seq}`,
      email: opts.email,
      name: opts.email,
      avatarUrl: null,
      googleSub: opts.sub,
      createdAt: T0,
      lastSignInAt: null,
    };
    this.state.users.push(user);
    this.state.memberships.push({
      workspaceId: WS,
      userId: user.id,
      role: opts.role,
      status: opts.status ?? 'active',
      statusChangedAt: null,
      statusChangedBy: null,
      joinedAt: T0,
    });
    return user;
  }

  roleOf(userId: string): Role | undefined {
    return this.state.memberships.find((m) => m.userId === userId)?.role;
  }
}

class FakeAudit {
  events: { event: AuditEventInput; inTx: boolean }[] = [];
  record = async (event: AuditEventInput, tx?: unknown) => {
    this.events.push({ event, inTx: tx !== undefined });
  };
}

class TestClock {
  constructor(public t: Date) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

// ---------------------------------------------------------------------------

let repo: FakeRepo;
let audit: FakeAudit;
let idp: MockIdentityProvider;
let clock: TestClock;
let service: SignInService;

function build(adminEmails: string[] = []) {
  service = new SignInService({
    repo,
    idp,
    audit,
    clock,
    config: { allowedDomain: 'onlytraf.com', adminEmails },
    workspace: { id: WS },
  });
}

beforeEach(() => {
  repo = new FakeRepo();
  audit = new FakeAudit();
  idp = new MockIdentityProvider();
  clock = new TestClock(T0);
  build();
});

/** Run start() and hand back the pieces the browser would carry to the callback. */
async function begin(returnTo?: unknown) {
  const { authorizationUrl, bindingValue } = await service.start({ returnTo });
  const state = new URL(authorizationUrl).searchParams.get('state')!;
  return { state, bindingValue, authorizationUrl };
}

async function signIn(identity: Parameters<MockIdentityProvider['setIdentity']>[0] = {}, extra = {}) {
  idp.setIdentity(identity);
  const { state, bindingValue } = await begin();
  return service.callback({ code: 'code-1', state, bindingValue, ...extra });
}

async function expectFlowError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuthFlowError);
  expect((err as AuthFlowError).flowCode).toBe(code);
}

function rejections() {
  return audit.events.filter((e) => e.event.action === 'auth.sign_in_rejected').map((e) => e.event);
}

// ---------------------------------------------------------------------------

describe('SignInService.start (AC-7, AC-16)', () => {
  it('stores only hashes + a PKCE verifier and sends an S256 challenge', async () => {
    const { state, bindingValue, authorizationUrl } = await begin('/repos/1/pulls');
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const [stored] = [...repo.state.flows.entries()];
    expect(stored![0]).toBe(sha256Hex(state));
    expect(stored![1].bindingHash).toBe(sha256Hex(bindingValue));
    expect(stored![1].returnTo).toBe('/repos/1/pulls');
    expect(stored![1].nonce).toBe(url.searchParams.get('nonce'));
    expect(JSON.stringify(stored)).not.toContain(state);
    expect(JSON.stringify(stored)).not.toContain(bindingValue);
  });

  it('falls back to / for an off-site return target', async () => {
    for (const bad of ['https://evil.io', '//evil.io', 'javascript:alert(1)', '/\\evil.io']) {
      await begin(bad);
    }
    for (const flow of repo.state.flows.values()) expect(flow.returnTo).toBe('/');
  });
});

describe('SignInService.callback — state (AC-7)', () => {
  it('rejects missing, mismatched-binding, reused and expired state; a wrong binding leaves the flow usable', async () => {
    // missing
    await expectFlowError(service.callback({ code: 'c', bindingValue: 'b' }), 'auth_state_invalid');

    // mismatched binding (another browser) — and a missing one
    let flow = await begin();
    await expectFlowError(
      service.callback({ code: 'c', state: flow.state, bindingValue: 'someone-else' }),
      'auth_state_invalid',
    );
    await expectFlowError(service.callback({ code: 'c', state: flow.state }), 'auth_state_invalid');
    // G3: neither burned the victim's in-flight flow — the right browser still signs in…
    expect(repo.state.flows.size).toBe(1);
    await service.callback({ code: 'c', state: flow.state, bindingValue: flow.bindingValue });

    // …exactly once: reused after a success
    await expectFlowError(
      service.callback({ code: 'c', state: flow.state, bindingValue: flow.bindingValue }),
      'auth_state_invalid',
    );

    // expired (> 10 min)
    flow = await begin();
    clock.advance(OAUTH_FLOW_TTL_MS + 1);
    await expectFlowError(
      service.callback({ code: 'c', state: flow.state, bindingValue: flow.bindingValue }),
      'auth_state_invalid',
    );

    expect(repo.state.sessions).toHaveLength(1); // only the one legitimate success
    expect(rejections().every((e) => e.metadata?.reason === 'auth_state_invalid')).toBe(true);
    expect(rejections()).toHaveLength(5);
  });
});

describe('SignInService.callback — admission (AC-9, AC-10)', () => {
  it.each([
    ['x@gmail.com, no hd', { email: 'x@gmail.com', hostedDomain: undefined }, 'auth_domain_not_allowed'],
    ['subdomain', { email: 'x@sub.onlytraf.com', hostedDomain: 'onlytraf.com' }, 'auth_domain_not_allowed'],
    ['suffix look-alike', { email: 'x@onlytraf.com.evil.io', hostedDomain: 'onlytraf.com' }, 'auth_domain_not_allowed'],
    ['hd of another domain', { email: 'x@onlytraf.com', hostedDomain: 'evil.io' }, 'auth_domain_not_allowed'],
    ['double @', { email: 'x@evil.io@onlytraf.com', hostedDomain: 'onlytraf.com' }, 'auth_domain_not_allowed'],
    ['email_verified=false', { email: 'x@onlytraf.com', emailVerified: false }, 'auth_email_unverified'],
  ])('rejects %s and writes nothing', async (_label, identity, code) => {
    await expectFlowError(signIn(identity), code);
    expect(repo.identityWrites()).toEqual([]);
    expect(repo.state.users).toHaveLength(0);
    expect(repo.state.sessions).toHaveLength(0);
    const [rejected] = rejections();
    expect(rejected).toMatchObject({ actorUserId: null, metadata: { reason: code } });
  });

  it('audits the verified email of a rejected identity, but not an unverified one', async () => {
    await expectFlowError(signIn({ email: 'x@gmail.com', hostedDomain: undefined }), 'auth_domain_not_allowed');
    await expectFlowError(signIn({ email: 'y@onlytraf.com', emailVerified: false }), 'auth_email_unverified');
    const [a, b] = rejections();
    expect(a!.metadata).toEqual({ reason: 'auth_domain_not_allowed', email: 'x@gmail.com' });
    expect(b!.metadata).toEqual({ reason: 'auth_email_unverified' });
  });

  it('accepts the allowed domain case-insensitively', async () => {
    const out = await signIn({ email: 'Bob@OnlyTraf.COM', hostedDomain: 'onlytraf.com', subject: 's-bob' });
    expect(out.role).toBe('member');
  });

  it('derives identity from the verified token only — the input has no email/hd/role channel', async () => {
    idp.setIdentity({ email: 'x@gmail.com', hostedDomain: undefined });
    const { state, bindingValue } = await begin();
    const forged = { code: 'c', state, bindingValue, email: 'boss@onlytraf.com', hd: 'onlytraf.com', role: 'admin' };
    await expectFlowError(service.callback(forged as never), 'auth_domain_not_allowed');
    expect(repo.state.users).toHaveLength(0);
  });
});

describe('SignInService.callback — users, memberships, sessions', () => {
  it('first sign-in creates one user + Member membership + session (AC-11, AC-24, AC-52)', async () => {
    const out = await signIn({ subject: 'sub-new', email: 'new@onlytraf.com', name: 'New Person' });
    expect(out.role).toBe('member');
    expect(out.returnTo).toBe('/');
    expect(repo.state.users).toEqual([expect.objectContaining({ googleSub: 'sub-new', name: 'New Person' })]);
    expect(repo.state.memberships).toEqual([
      expect.objectContaining({ userId: out.userId, role: 'member', status: 'active' }),
    ]);
    // only the hash of the session value is stored
    expect(repo.state.sessions).toEqual([expect.objectContaining({ idHash: sha256Hex(out.sessionValue) })]);
    expect(out.sessionValue.length).toBeGreaterThanOrEqual(43);

    const signInEvent = audit.events.find((e) => e.event.action === 'auth.sign_in')!;
    expect(signInEvent.inTx).toBe(true);
    expect(signInEvent.event).toMatchObject({ actorUserId: out.userId, targetType: 'user', targetId: out.userId });
    expect(JSON.stringify(audit.events)).not.toContain(out.sessionValue);
  });

  it('returns the stored return target', async () => {
    idp.setIdentity({});
    const { state, bindingValue } = await begin('/repos/42/pulls?tab=open');
    const out = await service.callback({ code: 'c', state, bindingValue });
    expect(out.returnTo).toBe('/repos/42/pulls?tab=open');
  });

  it('a returning user is matched by sub, profile refreshed, role unchanged (AC-12)', async () => {
    const admin = repo.seedMember({ sub: 'sub-a', email: 'old@onlytraf.com', role: 'admin' });
    const out = await signIn({ subject: 'sub-a', email: 'renamed@onlytraf.com', name: 'New Name' });
    expect(out.userId).toBe(admin.id);
    expect(out.role).toBe('admin');
    expect(repo.state.users).toHaveLength(1);
    expect(repo.state.users[0]).toMatchObject({ email: 'renamed@onlytraf.com', name: 'New Name' });
    expect(repo.state.memberships).toHaveLength(1);
  });

  it('discards the session cookie the browser already held (AC-24)', async () => {
    const first = await signIn({ subject: 'sub-x' });
    const second = await signIn({ subject: 'sub-x' }, { previousSessionValue: first.sessionValue });
    expect(second.sessionValue).not.toBe(first.sessionValue);
    expect(repo.state.sessions.map((s) => s.idHash)).toEqual([sha256Hex(second.sessionValue)]);
  });

  it('rejects a deactivated member with no write and keeps them deactivated (AC-14)', async () => {
    const u = repo.seedMember({ sub: 'sub-d', email: 'gone@onlytraf.com', role: 'member', status: 'deactivated' });
    build(['gone@onlytraf.com']); // even allowlisted
    await expectFlowError(signIn({ subject: 'sub-d', email: 'gone@onlytraf.com' }), 'auth_account_deactivated');
    expect(repo.identityWrites()).toEqual([]);
    expect(repo.state.memberships[0]).toMatchObject({ userId: u.id, status: 'deactivated', role: 'member' });
    expect(repo.state.sessions).toHaveLength(0);
    expect(rejections()[0]!.metadata).toEqual({ reason: 'auth_account_deactivated', email: 'gone@onlytraf.com' });
  });

  it('IdP unreachable → auth_idp_unavailable, no identity writes (AC-15)', async () => {
    idp.fail('idp_down');
    await expectFlowError(signIn(), 'auth_idp_unavailable');
    expect(repo.identityWrites()).toEqual([]);
    expect(repo.state.users).toHaveLength(0);
  });

  it('a code-less callback (Google returned an error) → auth_idp_unavailable', async () => {
    const { state, bindingValue } = await begin();
    await expectFlowError(service.callback({ state, bindingValue }), 'auth_idp_unavailable');
    expect(repo.identityWrites()).toEqual([]);
  });

  it('a token that fails verification → auth_token_invalid, no writes (AC-8)', async () => {
    idp.fail('bad_token');
    await expectFlowError(signIn(), 'auth_token_invalid');
    expect(repo.identityWrites()).toEqual([]);
  });

  it('maps an email already owned by another Google account to an auth error, not a 500', async () => {
    repo.upsertError = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const err = await signIn({ subject: 'sub-new', email: 'taken@onlytraf.com' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthFlowError);
    expect((err as AuthFlowError).flowCode).toBe('auth_token_invalid');
    // The browser gets only the generic auth_token_invalid text — no hint that
    // a member with this email exists; the reason lives in the audit row only.
    expect((err as AuthFlowError).message).toBe(new AuthFlowError('auth_token_invalid').message);
    expect((err as AuthFlowError).message).not.toMatch(/conflict|existing member/i);
    expect(repo.state.users).toHaveLength(0);
    expect(repo.state.sessions).toHaveLength(0);
    expect(rejections()[0]!.metadata).toEqual({ reason: 'email_conflict', email: 'taken@onlytraf.com' });
  });

  it('infrastructure errors propagate as-is (fail closed, not an auth redirect)', async () => {
    repo.upsertError = new Error('connection refused');
    await expect(signIn()).rejects.toThrow('connection refused');
    expect(repo.state.sessions).toHaveLength(0);
  });
});

describe('SignInService.callback — admin allowlist (AC-17, AC-18)', () => {
  it('allowlisted first sign-in → Admin (case-insensitive)', async () => {
    repo.seedMember({ sub: 'sub-boss', email: 'boss@onlytraf.com', role: 'admin' });
    build(['Lead@OnlyTraf.com']);
    const out = await signIn({ subject: 'sub-lead', email: 'lead@onlytraf.com' });
    expect(out.role).toBe('admin');
    expect(repo.roleOf(out.userId)).toBe('admin');
  });

  it('allowlisted existing Member stays Member while another Admin exists', async () => {
    repo.seedMember({ sub: 'sub-boss', email: 'boss@onlytraf.com', role: 'admin' });
    const m = repo.seedMember({ sub: 'sub-m', email: 'm@onlytraf.com', role: 'member' });
    build(['m@onlytraf.com']);
    const out = await signIn({ subject: 'sub-m', email: 'm@onlytraf.com' });
    expect(out.role).toBe('member');
    expect(repo.roleOf(m.id)).toBe('member');
    expect(repo.writes).not.toContain('memberships.setRole');
  });

  it('same Member is promoted once the workspace has zero active Admins', async () => {
    repo.seedMember({ sub: 'sub-boss', email: 'boss@onlytraf.com', role: 'admin', status: 'deactivated' });
    const m = repo.seedMember({ sub: 'sub-m', email: 'm@onlytraf.com', role: 'member' });
    build(['m@onlytraf.com']);
    const out = await signIn({ subject: 'sub-m', email: 'm@onlytraf.com' });
    expect(out.role).toBe('admin');
    expect(repo.roleOf(m.id)).toBe('admin');
    const ev = audit.events.find((e) => e.event.action === 'auth.sign_in')!;
    expect(ev.event.metadata).toMatchObject({ promoted_by_allowlist: true, role: 'admin' });
  });

  it('the seeded system user (no google sub) is not an active Admin: allowlisted Member is promoted', async () => {
    repo.seedMember({ sub: null, email: 'system@devdigest.local', role: 'admin' });
    const m = repo.seedMember({ sub: 'sub-m', email: 'm@onlytraf.com', role: 'member' });
    build(['m@onlytraf.com']);
    const out = await signIn({ subject: 'sub-m', email: 'm@onlytraf.com' });
    expect(out.role).toBe('admin');
    expect(repo.roleOf(m.id)).toBe('admin');
  });

  it('bootstrap with only the system admin: non-allowlisted → Member, then allowlisted → Admin', async () => {
    repo.seedMember({ sub: null, email: 'system@devdigest.local', role: 'admin' });
    build(['lead@onlytraf.com']);
    const plain = await signIn({ subject: 'sub-p', email: 'p@onlytraf.com' });
    expect(plain.role).toBe('member');
    expect(await repo.memberships.countActiveAdmins(WS)).toBe(0);
    const lead = await signIn({ subject: 'sub-lead', email: 'lead@onlytraf.com' });
    expect(lead.role).toBe('admin');
    expect(await repo.memberships.countActiveAdmins(WS)).toBe(1);
  });

  it('a non-allowlisted user is never promoted, even with zero Admins', async () => {
    const out = await signIn({ subject: 'sub-z', email: 'z@onlytraf.com' });
    expect(out.role).toBe('member');
  });

  it('an Admin-demoted allowlisted user stays Member across later sign-ins (AC-18)', async () => {
    repo.seedMember({ sub: 'sub-boss', email: 'boss@onlytraf.com', role: 'admin' });
    build(['ally@onlytraf.com']);
    const first = await signIn({ subject: 'sub-ally', email: 'ally@onlytraf.com' });
    expect(first.role).toBe('admin');
    // an Admin demotes them in the UI
    repo.state.memberships.find((m) => m.userId === first.userId)!.role = 'member';
    for (let i = 0; i < 2; i++) {
      const again = await signIn({ subject: 'sub-ally', email: 'ally@onlytraf.com' });
      expect(again.role).toBe('member');
    }
    expect(repo.roleOf(first.userId)).toBe('member');
  });

  it('the allowlist never demotes an Admin who is not on it', async () => {
    const a = repo.seedMember({ sub: 'sub-a', email: 'a@onlytraf.com', role: 'admin' });
    build(['someone-else@onlytraf.com']);
    const out = await signIn({ subject: 'sub-a', email: 'a@onlytraf.com' });
    expect(out.role).toBe('admin');
    expect(repo.roleOf(a.id)).toBe('admin');
  });
});

describe('SignInService.signOut (AC-26)', () => {
  it('deletes the session by hash and audits it; unknown values are a no-op', async () => {
    const out = await signIn({ subject: 'sub-o' });
    await service.signOut({ sessionValue: out.sessionValue, actorUserId: out.userId });
    expect(repo.state.sessions).toHaveLength(0);
    const ev = audit.events.find((e) => e.event.action === 'auth.sign_out')!;
    expect(ev.event).toMatchObject({ actorUserId: out.userId, targetId: out.userId });
    expect(JSON.stringify(ev)).not.toContain(out.sessionValue);

    const before = audit.events.length;
    await service.signOut({ sessionValue: out.sessionValue, actorUserId: out.userId });
    await service.signOut({ sessionValue: undefined, actorUserId: null });
    expect(audit.events.length).toBe(before);
  });
});
