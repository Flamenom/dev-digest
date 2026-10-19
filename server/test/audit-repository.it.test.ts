import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { AuditRepository, normalizeAuditIp, scrubMetadata } from '../src/modules/audit/repository.js';

/**
 * T8 — append-only audit trail (AC-52 storage half): row fields persisted,
 * metadata scrubbed at the repository boundary, UPDATE/DELETE refused by the
 * migration-0021 trigger, and `tx` joins the caller's transaction.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('AuditRepository', () => {
  let pg: PgFixture;
  let repo: AuditRepository;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    pg = await startPg();
    repo = new AuditRepository(pg.handle.db);
    const [ws] = await pg.handle.db.insert(t.workspaces).values({ name: 'audit-ws' }).returning();
    const [u] = await pg.handle.db.insert(t.users).values({ email: 'a@onlytraf.com', name: 'A' }).returning();
    workspaceId = ws!.id;
    userId = u!.id;
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('persists every field and scrubs sensitive metadata keys', async () => {
    await repo.record({
      workspaceId,
      actorUserId: userId,
      action: 'member.role_change',
      targetType: 'user',
      targetId: 'u-42',
      ip: '10.0.0.7',
      metadata: {
        from: 'member',
        to: 'admin',
        token_id: 'tok-1',
        token_name: 'laptop',
        key_name: 'OPENROUTER_API_KEY',
        value: 'sk-or-plaintext',
        api_token: 'ddg_pat_raw',
        clientSecret: 'shh',
        session_cookie: 'c00kie',
        password: 'hunter2',
        code: 'auth-code',
        idToken: 'eyJ.raw',
        nested: { secret_value: 'deep', keep: 1, list: [{ token: 'x', ok: true }] },
      },
    });

    const rows = await pg.handle.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.action, 'member.role_change'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      workspaceId,
      actorUserId: userId,
      action: 'member.role_change',
      targetType: 'user',
      targetId: 'u-42',
      ip: '10.0.0.7',
    });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.metadata).toEqual({
      from: 'member',
      to: 'admin',
      token_id: 'tok-1',
      token_name: 'laptop',
      key_name: 'OPENROUTER_API_KEY',
      nested: { keep: 1, list: [{ ok: true }] },
    });
    const serialized = JSON.stringify(row);
    for (const leaked of ['sk-or-plaintext', 'ddg_pat_raw', 'shh', 'c00kie', 'hunter2', 'auth-code', 'eyJ.raw', 'deep']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('defaults optional fields: null actor, target id, ip and empty metadata', async () => {
    await repo.record({ workspaceId, actorUserId: null, action: 'auth.sign_in_rejected', targetType: 'session' });
    const [row] = await pg.handle.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.action, 'auth.sign_in_rejected'));
    expect(row).toMatchObject({ actorUserId: null, targetId: null, ip: null, metadata: {} });
  });

  it('refuses UPDATE and DELETE (append-only trigger)', async () => {
    await repo.record({ workspaceId, actorUserId: userId, action: 'token.create', targetType: 'api_token' });
    const db = pg.handle.db;
    await expect(
      db.update(t.auditEvents).set({ action: 'tampered' }).where(eq(t.auditEvents.action, 'token.create')),
    ).rejects.toThrow(/append-only/);
    await expect(db.delete(t.auditEvents).where(eq(t.auditEvents.action, 'token.create'))).rejects.toThrow(
      /append-only/,
    );
    const rows = await db.select().from(t.auditEvents).where(eq(t.auditEvents.action, 'token.create'));
    expect(rows).toHaveLength(1);
  });

  it('stores ip as inet: valid IPv4/IPv6 kept, anything invalid stored as null (0023)', async () => {
    const cases: [string, string | null][] = [
      ['ip.v4', '203.0.113.9'],
      ['ip.v6', '2001:db8::1'],
      ['ip.garbage', null],
      ['ip.bad_octet', null],
      ['ip.cidr', null],
      ['ip.zone', null],
    ];
    const raw: Record<string, string> = {
      'ip.v4': ' 203.0.113.9 ',
      'ip.v6': '2001:db8::1',
      'ip.garbage': 'not-an-ip, 1.2.3.4',
      'ip.bad_octet': '999.1.1.1',
      'ip.cidr': '10.0.0.0/8',
      'ip.zone': 'fe80::1%eth0',
    };
    for (const [action] of cases) {
      await repo.record({ workspaceId, actorUserId: null, action, targetType: 'session', ip: raw[action] });
    }
    for (const [action, expected] of cases) {
      const [row] = await pg.handle.db.select().from(t.auditEvents).where(eq(t.auditEvents.action, action));
      expect(row?.ip ?? null, action).toBe(expected);
    }
    const [col] = (await pg.handle.db.execute(
      sql`select data_type from information_schema.columns where table_name = 'audit_events' and column_name = 'ip'`,
    )) as unknown as { data_type: string }[];
    expect(col!.data_type).toBe('inet');
  });

  it('refuses TRUNCATE (statement-level append-only trigger, 0023)', async () => {
    await expect(pg.handle.db.execute(sql`truncate audit_events`)).rejects.toThrow(/append-only/);
    const rows = await pg.handle.db.select().from(t.auditEvents);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rejects non-object metadata via CHECK (0023)', async () => {
    for (const bad of ['[]', '"str"', '1']) {
      await expect(
        pg.handle.db.execute(
          sql`insert into audit_events (workspace_id, action, target_type, metadata) values (${workspaceId}, 'ck', 'x', ${bad}::jsonb)`,
        ),
        bad,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('joins the caller transaction: a rolled-back tx leaves no row', async () => {
    const db = pg.handle.db;
    await expect(
      db.transaction(async (tx) => {
        await repo.record({ workspaceId, actorUserId: userId, action: 'secrets.import', targetType: 'secret' }, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const rows = await db.select().from(t.auditEvents).where(eq(t.auditEvents.action, 'secrets.import'));
    expect(rows).toHaveLength(0);
  });
});

describe('scrubMetadata', () => {
  it('returns {} for undefined and does not mutate its input', () => {
    expect(scrubMetadata(undefined)).toEqual({});
    const input = { value: 'x', keep: 'y' };
    expect(scrubMetadata(input)).toEqual({ keep: 'y' });
    expect(input).toEqual({ value: 'x', keep: 'y' });
  });

  it('normalizeAuditIp keeps only valid IP literals', () => {
    expect(normalizeAuditIp(undefined)).toBeNull();
    expect(normalizeAuditIp(null)).toBeNull();
    expect(normalizeAuditIp('')).toBeNull();
    expect(normalizeAuditIp('::ffff:1.2.3.4')).toBe('::ffff:1.2.3.4');
    expect(normalizeAuditIp('1.2.3.4:8080')).toBeNull();
  });

  it('drops binary values', () => {
    expect(scrubMetadata({ nonce: Buffer.from([1, 2]), n: 2 })).toEqual({ n: 2 });
  });
});
