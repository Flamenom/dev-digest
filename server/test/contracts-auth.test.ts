/**
 * Multi-user server contracts (plan T1): auth/members/tokens shapes, the
 * nullable ActorRef + optional actor extensions (existing fixtures keep
 * parsing), and the detailed secrets status (never value-derived keys).
 */
import { describe, it, expect } from 'vitest';
import {
  API_TOKEN_PREFIX,
  ActorRef,
  AgentWithActors,
  ApiTokenCreateInput,
  AuthErrorCode,
  AuthzErrorCode,
  CSRF_HEADER,
  CurrentSession,
  FindingRecordWithActor,
  MemberList,
  MemberUpdate,
  MembersErrorCode,
  RunSummaryWithActor,
  SecretErrorCode,
  SecretStatusEntry,
  SecretsStatusDetailed,
  SecretsStatusHost,
} from '@devdigest/shared';

const session = {
  mode: 'google',
  user: { id: 'u1', email: 'a@onlytraf.com', name: 'A', avatar_url: null, role: 'member' },
  workspace: { id: 'w1', name: 'Team' },
  allowed_domain: 'onlytraf.com',
};

const entry = { state: 'set', updated_at: '2026-10-19T00:00:00Z', updated_by: null } as const;
const unset = { state: 'unset', updated_at: null, updated_by: null } as const;
const booleans = { openai: true, anthropic: false, openrouter: false, github: false, gitlab: false };
const states = { openai: entry, anthropic: unset, openrouter: unset, github: unset, gitlab: unset };

describe('auth contracts', () => {
  it('MemberUpdate rejects an empty (or unknown-keys-only) body and accepts one field', () => {
    expect(MemberUpdate.safeParse({}).success).toBe(false);
    expect(MemberUpdate.safeParse({ is_admin: true }).success).toBe(false);
    expect(MemberUpdate.safeParse({ role: 'owner' }).success).toBe(false);
    expect(MemberUpdate.parse({ role: 'admin' })).toEqual({ role: 'admin' });
    expect(MemberUpdate.parse({ status: 'deactivated' })).toEqual({ status: 'deactivated' });
  });

  it('ApiTokenCreateInput bounds the name and defaults expiry to 90 days', () => {
    expect(ApiTokenCreateInput.safeParse({ name: '' }).success).toBe(false);
    expect(ApiTokenCreateInput.safeParse({ name: '   ' }).success).toBe(false);
    expect(ApiTokenCreateInput.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
    expect(ApiTokenCreateInput.parse({ name: 'x'.repeat(64) }).expires_in_days).toBe(90);
    expect(ApiTokenCreateInput.parse({ name: 'mcp', expires_in_days: 365 }).expires_in_days).toBe(365);
    for (const bad of [0, 366, 1.5, '30']) {
      expect(ApiTokenCreateInput.safeParse({ name: 'mcp', expires_in_days: bad }).success).toBe(false);
    }
  });

  it('CurrentSession accepts both modes, requires a valid role and nullable avatar', () => {
    expect(CurrentSession.parse(session)).toEqual(session);
    const { allowed_domain: _omit, ...local } = { ...session, mode: 'local' };
    expect(CurrentSession.safeParse(local).success).toBe(true);
    expect(CurrentSession.safeParse({ ...session, mode: 'saml' }).success).toBe(false);
    expect(
      CurrentSession.safeParse({ ...session, user: { ...session.user, role: 'owner' } }).success,
    ).toBe(false);
    const { avatar_url: _a, ...noAvatar } = session.user;
    expect(CurrentSession.safeParse({ ...session, user: noAvatar }).success).toBe(false);
  });

  it('MemberList parses members with nullable last sign-in', () => {
    const member = {
      user_id: 'u1',
      email: 'a@onlytraf.com',
      name: 'A',
      avatar_url: null,
      role: 'admin',
      status: 'active',
      joined_at: '2026-10-19T00:00:00Z',
      last_sign_in_at: null,
    };
    expect(MemberList.parse({ members: [member], has_active_admin: true }).members).toHaveLength(1);
    expect(MemberList.safeParse({ members: [{ ...member, status: 'x' }], has_active_admin: true }).success).toBe(false);
  });

  it('exposes the stable error codes and constants', () => {
    expect(AuthErrorCode.options).toContain('auth_domain_not_allowed');
    expect(AuthzErrorCode.options).toEqual(['forbidden_role', 'forbidden_owner', 'csrf_rejected', 'session_required']);
    expect(MembersErrorCode.options).toEqual(['last_admin', 'token_limit']);
    expect(SecretErrorCode.options).toEqual(['secret_undecryptable']);
    expect(CSRF_HEADER).toBe('x-devdigest-csrf');
    expect(API_TOKEN_PREFIX).toBe('ddg_pat_');
  });
});

describe('actor contracts', () => {
  it('ActorRef is a ref or null', () => {
    expect(ActorRef.parse(null)).toBeNull();
    expect(ActorRef.parse({ user_id: 'u1', name: 'A', is_system: true })).toEqual({
      user_id: 'u1',
      name: 'A',
      is_system: true,
    });
    expect(ActorRef.safeParse(undefined).success).toBe(false);
    expect(ActorRef.safeParse({ name: 'A' }).success).toBe(false);
  });

  it('extension schemas keep accepting fixtures without actor fields', () => {
    const run = {
      run_id: 'r1', agent_id: null, agent_name: null, provider: null, model: null, status: 'done',
      error: null, duration_ms: null, tokens_in: null, tokens_out: null, cost_usd: null,
      findings_count: null, grounding: null, ran_at: null, score: null, blockers: null,
    };
    expect(RunSummaryWithActor.parse(run).started_by).toBeUndefined();
    expect(RunSummaryWithActor.parse({ ...run, started_by: null }).started_by).toBeNull();

    const agent = {
      id: 'a1', name: 'A', description: '', provider: 'openai', model: 'm', system_prompt: '',
      enabled: true, version: 1,
    };
    expect(AgentWithActors.safeParse(agent).success).toBe(true);
    expect(
      AgentWithActors.safeParse({ ...agent, created_by: { user_id: 'u', name: 'U' }, updated_by: null }).success,
    ).toBe(true);
    expect(FindingRecordWithActor.shape.acted_by.isOptional()).toBe(true);
  });
});

describe('secrets status contracts', () => {
  it('SecretsStatusDetailed = host booleans + per-provider states', () => {
    const parsed = SecretsStatusDetailed.parse({ ...booleans, states });
    expect(parsed.states.openai.state).toBe('set');
    // Old readers keep working: the boolean schema strips `states`.
    expect(SecretsStatusHost.parse(parsed)).toEqual(booleans);
    expect(SecretsStatusDetailed.safeParse({ ...booleans, states: { ...states, gitlab: undefined } }).success).toBe(false);
    expect(
      SecretsStatusDetailed.safeParse({ ...booleans, states: { ...states, openai: { ...entry, state: 'present' } } }).success,
    ).toBe(false);
  });

  it('an entry never carries value-derived keys', () => {
    expect(Object.keys(SecretStatusEntry.shape).sort()).toEqual(['state', 'updated_at', 'updated_by']);
    for (const leak of ['value', 'value_length', 'prefix', 'last4', 'hash']) {
      expect(SecretStatusEntry.safeParse({ ...entry, [leak]: 'x' }).success).toBe(false);
    }
  });
});
