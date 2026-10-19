import { describe, it, expect, beforeEach } from 'vitest';
import type { AuditEventInput } from '@devdigest/shared';
import {
  TokensService,
  type TokenActor,
  type TokensIdentityPort,
} from '../src/modules/identity/tokens-service.js';
import type { ApiTokenRecord, IdentityTx, NewApiToken } from '../src/modules/identity/repository.js';
import { newApiToken, sha256Hex } from '../src/platform/crypto/tokens.js';
import { TOKEN_LIMIT } from '../src/modules/identity/constants.js';

/**
 * T13 — TokensService against an in-memory fake (hermetic).
 * AC-55 create (shown once, stored hashed, default 90 d, 1–365), AC-58
 * ≤10 active, own list, revoke own-or-Admin, audit with id + name only.
 */

const WS = 'ws-1';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TX = { fake: 'tx' } as unknown as IdentityTx;

interface Stored extends ApiTokenRecord {
  tokenHash: string;
}

describe('TokensService', () => {
  let rows: Stored[];
  let audit: AuditEventInput[];
  let svc: TokensService;
  let lastValue: string;
  let seq: number;
  let locks: number;

  const alice: TokenActor = { userId: 'alice', workspaceId: WS, role: 'member', via: 'session' };
  const bob: TokenActor = { userId: 'bob', workspaceId: WS, role: 'member', via: 'session' };
  const admin: TokenActor = { userId: 'root', workspaceId: WS, role: 'admin', via: 'session' };

  const strip = ({ tokenHash: _h, ...r }: Stored): ApiTokenRecord => r;

  beforeEach(() => {
    rows = [];
    audit = [];
    seq = 0;
    locks = 0;
    const identity: TokensIdentityPort = {
      apiTokens: {
        create: async (input: NewApiToken, tx) => {
          expect(tx).toBe(TX);
          seq += 1;
          const row: Stored = {
            id: `tok-${seq}`,
            userId: input.userId,
            workspaceId: input.workspaceId,
            name: input.name,
            prefix: input.prefix,
            tokenHash: input.tokenHash,
            createdAt: input.now,
            lastUsedAt: null,
            expiresAt: input.expiresAt,
            revokedAt: null,
          };
          rows.push(row);
          return strip(row);
        },
        findById: async (ws, id) => {
          const r = rows.find((x) => x.workspaceId === ws && x.id === id);
          return r ? strip(r) : undefined;
        },
        listForUser: async (ws, u) =>
          rows.filter((r) => r.workspaceId === ws && r.userId === u && !r.revokedAt).map(strip),
        countActive: async (ws, u, now) =>
          rows.filter((r) => r.workspaceId === ws && r.userId === u && !r.revokedAt && r.expiresAt > now)
            .length,
        revoke: async (ws, id, now) => {
          const r = rows.find((x) => x.workspaceId === ws && x.id === id && !x.revokedAt);
          if (!r) return false;
          r.revokedAt = now;
          return true;
        },
      },
      transaction: (async (fn: (tx: IdentityTx) => Promise<unknown>) => fn(TX)) as TokensIdentityPort['transaction'],
      withWorkspaceLock: (async (_ws: string, fn: (tx: IdentityTx) => Promise<unknown>) => {
        locks += 1;
        return fn(TX);
      }) as TokensIdentityPort['withWorkspaceLock'],
    };
    svc = new TokensService({
      identity,
      audit: { record: async (e) => void audit.push(e) },
      clock: { now: () => NOW },
      generate: () => {
        const t = newApiToken();
        lastValue = t.value;
        return t;
      },
    });
  });

  it('AC-55: creates a token shown once, stores only its hash, default 90 days, audits id+name', async () => {
    const created = await svc.create({ ...alice, ip: '10.0.0.9' }, { name: '  laptop mcp  ' });
    expect(created.token).toBe(lastValue);
    expect(created.token.startsWith('ddg_pat_')).toBe(true);
    expect(created.name).toBe('laptop mcp');
    expect(created.prefix).toBe(created.token.slice(0, 12));
    expect(created.expires_at).toBe(new Date(NOW.getTime() + 90 * DAY).toISOString());
    expect(locks).toBe(1);

    expect(rows[0]!.tokenHash).toBe(sha256Hex(created.token));
    expect(JSON.stringify(rows)).not.toContain(created.token);

    expect(audit).toEqual([
      {
        workspaceId: WS,
        actorUserId: 'alice',
        action: 'token.create',
        targetType: 'api_token',
        targetId: created.id,
        metadata: { token_id: created.id, token_name: 'laptop mcp' },
        ip: '10.0.0.9',
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(created.token);

    const listed = await svc.list(alice);
    expect(listed).toEqual([
      {
        id: created.id,
        name: 'laptop mcp',
        prefix: created.prefix,
        created_at: NOW.toISOString(),
        last_used_at: null,
        expires_at: created.expires_at,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(await svc.list(bob)).toEqual([]);
  });

  it('validates name and expiry against the contract', async () => {
    const ok = await svc.create(alice, { name: 'x', expires_in_days: 365 });
    expect(ok.expires_at).toBe(new Date(NOW.getTime() + 365 * DAY).toISOString());
    for (const bad of [
      { name: '   ' },
      { name: 'a'.repeat(65) },
      { name: 'ok', expires_in_days: 0 },
      { name: 'ok', expires_in_days: 366 },
      { name: 'ok', expires_in_days: 1.5 },
    ]) {
      await expect(svc.create(alice, bad)).rejects.toMatchObject({ code: 'validation_error' });
    }
    expect(rows).toHaveLength(1);
  });

  it('AC-58: an 11th active token → token_limit; revoked/expired ones do not count', async () => {
    for (let i = 0; i < TOKEN_LIMIT; i++) await svc.create(alice, { name: `t${i}` });
    await expect(svc.create(alice, { name: 'one too many' })).rejects.toMatchObject({
      code: 'token_limit',
      statusCode: 409,
    });
    expect(rows).toHaveLength(TOKEN_LIMIT);

    await svc.revoke(alice, rows[0]!.id);
    await expect(svc.create(alice, { name: 'after revoke' })).resolves.toBeTruthy();

    rows[1]!.expiresAt = new Date(NOW.getTime() - 1);
    await expect(svc.create(alice, { name: 'after expiry' })).resolves.toBeTruthy();
    // Another user is unaffected by alice's count.
    await expect(svc.create(bob, { name: 'bob' })).resolves.toBeTruthy();
  });

  it('revoke: owner or Admin; another Member → forbidden_owner; unknown/revoked → not_found', async () => {
    const a1 = await svc.create(alice, { name: 'a1' });
    const a2 = await svc.create(alice, { name: 'a2' });
    audit = [];

    await expect(svc.revoke(bob, a1.id)).rejects.toMatchObject({ code: 'forbidden_owner', statusCode: 403 });
    expect(rows.find((r) => r.id === a1.id)!.revokedAt).toBeNull();

    await svc.revoke(alice, a1.id);
    expect(rows.find((r) => r.id === a1.id)!.revokedAt).toEqual(NOW);
    await expect(svc.revoke(alice, a1.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.revoke(alice, 'nope')).rejects.toMatchObject({ code: 'not_found' });

    await svc.revoke(admin, a2.id);
    expect(audit).toEqual([
      expect.objectContaining({ action: 'token.revoke', actorUserId: 'alice', metadata: { token_id: a1.id, token_name: 'a1' } }),
      expect.objectContaining({ action: 'token.revoke', actorUserId: 'root', metadata: { token_id: a2.id, token_name: 'a2' } }),
    ]);
    expect(await svc.list(alice)).toEqual([]);
  });

  it('a token principal cannot create or revoke tokens', async () => {
    const a1 = await svc.create(alice, { name: 'a1' });
    await expect(svc.create({ ...alice, via: 'token' }, { name: 'x' })).rejects.toMatchObject({
      code: 'session_required',
    });
    await expect(svc.revoke({ ...alice, via: 'token' }, a1.id)).rejects.toMatchObject({
      code: 'session_required',
    });
    expect(rows).toHaveLength(1);
  });
});
