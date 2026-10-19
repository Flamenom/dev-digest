import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ActorRefValue, EvalExpectedOutput } from '@devdigest/shared';
import {
  EvalService,
  type EvalActor,
  type EvalServiceFinding,
  type EvalServicePull,
  type EvalServiceReview,
} from '../src/modules/eval/service.js';
import { withCaseCreators } from '../src/modules/eval/actors.js';
import type {
  EvalCaseDeleteResult,
  EvalCaseDomain,
  EvalCasePatch,
  EvalRunDomain,
  NewEvalCase,
} from '../src/modules/eval/types.js';

/**
 * Multi-user T25 — hermetic: eval case creator (AC-47) and the "Member own /
 * Admin any" edit/delete rule (AC-30) in `EvalService`, over in-memory fakes.
 */

const WS = '00000000-0000-4000-8000-000000000001';
const OTHER_WS = '00000000-0000-4000-8000-000000000002';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const ALICE: EvalActor = { userId: '00000000-0000-4000-8000-00000000a11c', role: 'member' };
const BOB: EvalActor = { userId: '00000000-0000-4000-8000-000000000b0b', role: 'member' };
const ADMIN: EvalActor = { userId: '00000000-0000-4000-8000-0000000ad111', role: 'admin' };

const DIFF = [
  'diff --git a/src/pay.ts b/src/pay.ts',
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  '@@ -10,3 +10,4 @@',
  '   port: 3000,',
  '+  stripeKey: "sk_live_xxx",',
].join('\n');
const EXPECTED: EvalExpectedOutput = {
  kind: 'must_find',
  expectations: [{ file: 'src/pay.ts', start_line: 11, end_line: 11, title: 'Hardcoded key' }],
};

class FakeEvalRepo {
  cases: EvalCaseDomain[] = [];
  writes: string[] = [];

  async listCasesForOwner(ws: string, ownerId: string) {
    return this.cases.filter((c) => c.workspaceId === ws && c.ownerId === ownerId);
  }
  async getCase(ws: string, id: string) {
    return this.cases.find((c) => c.workspaceId === ws && c.id === id);
  }
  async insertCase(input: NewEvalCase): Promise<EvalCaseDomain> {
    this.writes.push('insert');
    const row: EvalCaseDomain = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      name: input.name,
      inputDiff: input.inputDiff,
      inputFiles: input.inputFiles ?? null,
      inputMeta: input.inputMeta ?? {},
      expectedOutput: input.expectedOutput ?? null,
      notes: input.notes ?? null,
      sourceFindingId: input.sourceFindingId ?? null,
      createdBy: input.createdBy ?? null,
    };
    this.cases.push(row);
    return row;
  }
  async updateCase(ws: string, id: string, patch: EvalCasePatch) {
    this.writes.push('update');
    const row = await this.getCase(ws, id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  }
  async deleteCase(ws: string, id: string): Promise<EvalCaseDeleteResult> {
    this.writes.push('delete');
    const idx = this.cases.findIndex((c) => c.workspaceId === ws && c.id === id);
    if (idx < 0) return { found: false, deleted: false, runCount: 0 };
    this.cases.splice(idx, 1);
    return { found: true, deleted: true, runCount: 0 };
  }
  async findCaseBySourceFinding(ws: string, findingId: string) {
    return this.cases.find((c) => c.workspaceId === ws && c.sourceFindingId === findingId);
  }
  async takenNamesForOwner(ws: string, ownerId: string) {
    return (await this.listCasesForOwner(ws, ownerId)).map((c) => c.name);
  }
  async caseLinksForPull() {
    return [];
  }
  async latestRunPerCase() {
    return new Map<string, EvalRunDomain>();
  }

  seed(over: Partial<EvalCaseDomain> = {}): EvalCaseDomain {
    const row: EvalCaseDomain = {
      id: randomUUID(),
      workspaceId: WS,
      ownerKind: 'agent',
      ownerId: AGENT,
      name: `case-${this.cases.length}`,
      inputDiff: DIFF,
      inputFiles: null,
      inputMeta: {},
      expectedOutput: EXPECTED,
      notes: null,
      sourceFindingId: null,
      createdBy: null,
      ...over,
    };
    this.cases.push(row);
    return row;
  }
}

const FINDING: EvalServiceFinding = {
  id: '00000000-0000-4000-8000-0000000000f1',
  file: 'src/pay.ts',
  startLine: 11,
  endLine: 11,
  severity: 'CRITICAL',
  category: 'security',
  title: 'Hardcoded Stripe key',
  acceptedAt: new Date(),
  dismissedAt: null,
};
const REVIEW: EvalServiceReview = { id: randomUUID(), agentId: AGENT };
const PULL: EvalServicePull = {
  id: randomUUID(),
  workspaceId: WS,
  number: 7,
  title: 'Add rate limiting',
  body: null,
  author: 'marisa',
  base: 'main',
  branch: 'feat/rl',
};

function harness() {
  const evalRepo = new FakeEvalRepo();
  const service = new EvalService({
    evalRepo,
    reviewRepo: {
      findingContext: async (id) =>
        id === FINDING.id ? { finding: FINDING, review: REVIEW, pull: PULL } : undefined,
      getPull: async () => ({ id: PULL.id }),
      getPrFiles: async () => [{ path: 'src/pay.ts', patch: '@@ -10,3 +10,4 @@\n+  x' }],
    },
    agentsRepo: { getById: async (ws, id) => (ws === WS && id === AGENT ? { id } : undefined) },
    runner: {
      runSingleCase: async () => {
        throw new Error('not used');
      },
      runDraftCase: async () => {
        throw new Error('not used');
      },
    },
  });
  return { evalRepo, service };
}

const caseInput = () => ({
  owner_kind: 'agent' as const,
  owner_id: AGENT,
  name: 'hand-made',
  input_diff: DIFF,
  input_meta: {},
  expected_output: EXPECTED,
});

describe('EvalService — case creator (AC-47)', () => {
  it('createCase and createFromFinding record the acting user; a re-click keeps the first creator', async () => {
    const h = harness();

    const made = await h.service.createCase(WS, caseInput(), ALICE);
    expect(made.creator_id).toBe(ALICE.userId);
    expect(h.evalRepo.cases.find((c) => c.id === made.id)?.createdBy).toBe(ALICE.userId);

    const first = await h.service.createFromFinding(WS, FINDING.id, null, BOB);
    expect(first.created).toBe(true);
    expect(first.record.creator_id).toBe(BOB.userId);

    const again = await h.service.createFromFinding(WS, FINDING.id, null, ALICE);
    expect(again.created).toBe(false);
    expect(again.record.creator_id).toBe(BOB.userId);

    // Without an actor (in-process callers) nothing is attributed.
    const anon = await h.service.createCase(WS, { ...caseInput(), name: 'anon' });
    expect(anon.creator_id).toBeNull();
  });

  it('a creator id in the body is ignored (A08)', async () => {
    const h = harness();
    const body = { ...caseInput(), created_by: BOB.userId } as ReturnType<typeof caseInput>;
    const made = await h.service.createCase(WS, body, ALICE);
    expect(made.creator_id).toBe(ALICE.userId);
  });
});

describe('EvalService — edit/delete ownership (AC-30)', () => {
  it('update: owner and Admin pass; another Member gets 403 forbidden_owner with no write', async () => {
    const h = harness();
    const own = h.evalRepo.seed({ createdBy: ALICE.userId });

    await expect(
      h.service.updateCase(WS, own.id, { notes: 'bob' }, BOB),
    ).rejects.toMatchObject({ code: 'forbidden_owner', statusCode: 403 });
    expect(h.evalRepo.writes).toEqual([]);
    expect(own.notes).toBeNull();

    expect((await h.service.updateCase(WS, own.id, { notes: 'mine' }, ALICE)).notes).toBe('mine');
    const byAdmin = await h.service.updateCase(WS, own.id, { notes: 'admin' }, ADMIN);
    expect(byAdmin.notes).toBe('admin');
    expect(byAdmin.creator_id).toBe(ALICE.userId);
  });

  it('delete: another Member 403 (row kept); owner 200', async () => {
    const h = harness();
    const own = h.evalRepo.seed({ createdBy: ALICE.userId });

    await expect(h.service.deleteCase(WS, own.id, {}, BOB)).rejects.toMatchObject({
      code: 'forbidden_owner',
    });
    expect(h.evalRepo.writes).toEqual([]);
    expect(h.evalRepo.cases).toHaveLength(1);

    await expect(h.service.deleteCase(WS, own.id, {}, ALICE)).resolves.toEqual({ deleted: true });
    expect(h.evalRepo.cases).toHaveLength(0);
  });

  it('legacy case (no creator) is Admin-only', async () => {
    const h = harness();
    const legacy = h.evalRepo.seed({ createdBy: null });
    // An older fake row that omits the field entirely reads as legacy too.
    const absent = h.evalRepo.seed();
    delete (absent as { createdBy?: unknown }).createdBy;

    for (const c of [legacy, absent]) {
      await expect(h.service.updateCase(WS, c.id, { notes: 'x' }, ALICE)).rejects.toMatchObject({
        code: 'forbidden_owner',
      });
      await expect(h.service.deleteCase(WS, c.id, {}, ALICE)).rejects.toMatchObject({
        code: 'forbidden_owner',
      });
    }
    expect(h.evalRepo.writes).toEqual([]);

    expect((await h.service.updateCase(WS, legacy.id, { notes: 'ok' }, ADMIN)).notes).toBe('ok');
    await expect(h.service.deleteCase(WS, legacy.id, {}, ADMIN)).resolves.toEqual({ deleted: true });
  });

  it("another workspace's case (or a missing one) is 404 for a Member, never 403 (A01)", async () => {
    const h = harness();
    const foreign = h.evalRepo.seed({ workspaceId: OTHER_WS, createdBy: BOB.userId });
    await expect(h.service.updateCase(WS, foreign.id, { notes: 'x' }, ALICE)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(h.service.deleteCase(WS, randomUUID(), {}, ALICE)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(h.evalRepo.writes).toEqual([]);
  });
});

describe('withCaseCreators — DTO enrichment', () => {
  it('resolves creators with one batched lookup, nulls legacy, and drops creator_id', async () => {
    const h = harness();
    h.evalRepo.seed({ name: 'a', createdBy: ALICE.userId });
    h.evalRepo.seed({ name: 'b', createdBy: ALICE.userId });
    h.evalRepo.seed({ name: 'c', createdBy: null });
    h.evalRepo.seed({ name: 'd', createdBy: BOB.userId }); // unknown to the directory
    const views = await h.service.listForAgent(WS, AGENT);

    const lookup = vi.fn(async (ids: readonly string[]) => {
      const m = new Map<string, ActorRefValue>();
      if (ids.includes(ALICE.userId)) m.set(ALICE.userId, { user_id: ALICE.userId, name: 'Alice' });
      return m;
    });
    const dtos = await withCaseCreators(views, lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect([...lookup.mock.calls[0]![0]].sort()).toEqual([ALICE.userId, BOB.userId].sort());
    const byName = Object.fromEntries(dtos.map((d) => [d.name, d]));
    expect(byName.a?.created_by).toEqual({ user_id: ALICE.userId, name: 'Alice' });
    expect(byName.b?.created_by).toEqual({ user_id: ALICE.userId, name: 'Alice' });
    expect(byName.c?.created_by).toBeNull();
    expect(byName.d?.created_by).toBeNull();
    for (const d of dtos) expect(d).not.toHaveProperty('creator_id');
  });

  it('does not call the directory when no case has a creator', async () => {
    const h = harness();
    h.evalRepo.seed({ createdBy: null });
    const lookup = vi.fn(async () => new Map<string, ActorRefValue>());
    const dtos = await withCaseCreators(await h.service.listForAgent(WS, AGENT), lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(dtos[0]?.created_by).toBeNull();
  });
});
