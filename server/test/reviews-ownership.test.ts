import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ActorRefValue } from '@devdigest/shared';
import { ReviewService } from '../src/modules/reviews/service.js';
import { ReviewRepository } from '../src/modules/reviews/repository.js';
import type { FindingRow, ReviewRow, PullRow } from '../src/modules/reviews/repository.js';
import { assertCanCancelRun, attachReviewActors } from '../src/modules/reviews/actors.js';
import type { Container } from '../src/platform/container.js';

/**
 * T24 — reviews ownership + attribution, hermetic (no DB): the repository is
 * stubbed on its prototype, the container is a minimal fake.
 */

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const WS = 'ws-1';

const directory = new Map<string, ActorRefValue>([
  [ALICE, { user_id: ALICE, name: 'Alice' }],
  [BOB, { user_id: BOB, name: 'Bob' }],
]);

function fakeContainer() {
  const runBus = { publish: vi.fn(), cancel: vi.fn(), complete: vi.fn() };
  const lookup = vi.fn(async (ids: readonly string[]) => {
    const out = new Map<string, ActorRefValue>();
    for (const id of ids) if (directory.has(id)) out.set(id, directory.get(id)!);
    return out;
  });
  const container = {
    db: {},
    agentsRepo: { getById: vi.fn(async () => undefined) },
    runBus,
    actorDirectory: { lookup },
  } as unknown as Container;
  return { container, runBus, lookup };
}

function findingRow(id: string, actedBy: string | null): FindingRow {
  return {
    id,
    reviewId: 'r-1',
    file: 'a.ts',
    startLine: 1,
    endLine: 1,
    severity: 'WARNING',
    category: 'bug',
    title: 't',
    rationale: 'r',
    suggestion: null,
    confidence: 0.9,
    kind: 'finding',
    trifectaComponents: null,
    acceptedAt: null,
    dismissedAt: new Date('2026-10-19T00:00:00Z'),
    actedBy,
  } as unknown as FindingRow;
}

afterEach(() => vi.restoreAllMocks());

describe('assertCanCancelRun (AC-30)', () => {
  it('allows the initiator and any Admin; refuses other Members and legacy runs for Members', () => {
    expect(() => assertCanCancelRun(ALICE, { userId: ALICE, role: 'member' })).not.toThrow();
    expect(() => assertCanCancelRun(ALICE, { userId: BOB, role: 'admin' })).not.toThrow();
    expect(() => assertCanCancelRun(null, { userId: BOB, role: 'admin' })).not.toThrow();
    expect(() => assertCanCancelRun(ALICE, { userId: BOB, role: 'member' })).toThrow(
      expect.objectContaining({ code: 'forbidden_owner', statusCode: 403 }),
    );
    expect(() => assertCanCancelRun(null, { userId: BOB, role: 'member' })).toThrow(
      expect.objectContaining({ code: 'forbidden_owner' }),
    );
  });
});

describe('ReviewService.cancelRun ownership', () => {
  it('refuses a non-owner Member BEFORE signalling or touching the run', async () => {
    const { container, runBus } = fakeContainer();
    vi.spyOn(ReviewRepository.prototype, 'getRunInitiator').mockResolvedValue({ initiatedBy: ALICE });
    const cancelRow = vi.spyOn(ReviewRepository.prototype, 'cancelRunIfRunning').mockResolvedValue(true);
    const service = new ReviewService(container);

    await expect(service.cancelRun(WS, 'run-1', { userId: BOB, role: 'member' })).rejects.toMatchObject({
      code: 'forbidden_owner',
    });
    expect(runBus.cancel).not.toHaveBeenCalled();
    expect(runBus.publish).not.toHaveBeenCalled();
    expect(cancelRow).not.toHaveBeenCalled();

    await service.cancelRun(WS, 'run-1', { userId: ALICE, role: 'member' });
    expect(runBus.cancel).toHaveBeenCalledWith('run-1');
    expect(cancelRow).toHaveBeenCalledWith(WS, 'run-1');
  });

  it('a foreign / unknown run is 404 regardless of role', async () => {
    const { container } = fakeContainer();
    vi.spyOn(ReviewRepository.prototype, 'getRunInitiator').mockResolvedValue(undefined);
    const service = new ReviewService(container);
    await expect(service.cancelRun(WS, 'nope', { userId: ALICE, role: 'admin' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('finding actor + DTO attribution', () => {
  it('records the actor on dismiss and returns acted_by', async () => {
    const { container } = fakeContainer();
    vi.spyOn(ReviewRepository.prototype, 'findingContext').mockResolvedValue({
      finding: findingRow('f-1', null),
      review: {} as ReviewRow,
      pull: { workspaceId: WS } as PullRow,
    });
    const dismiss = vi
      .spyOn(ReviewRepository.prototype, 'setFindingDismissed')
      .mockResolvedValue(findingRow('f-1', BOB));
    const service = new ReviewService(container);

    const { finding } = await service.actOnFinding(WS, 'f-1', 'dismiss', BOB);
    expect(dismiss).toHaveBeenCalledWith('f-1', expect.any(Date), BOB);
    expect(finding.acted_by).toEqual({ user_id: BOB, name: 'Bob' });
  });

  it('resolves review started_by + finding acted_by with ONE lookup; legacy → null', async () => {
    const { lookup } = fakeContainer();
    const review = {
      id: 'r-1',
      prId: 'pr-1',
      agentId: null,
      runId: 'run-1',
      kind: 'review',
      verdict: null,
      summary: null,
      score: null,
      model: null,
      createdAt: new Date('2026-10-19T00:00:00Z'),
    } as unknown as ReviewRow;
    const [withActor, legacy] = await attachReviewActors(
      [
        { review, findings: [findingRow('f-1', BOB), findingRow('f-2', null)], initiatedBy: ALICE },
        { review: { ...review, id: 'r-2' }, findings: [], initiatedBy: null },
      ],
      lookup,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(withActor!.started_by).toEqual({ user_id: ALICE, name: 'Alice' });
    expect(withActor!.findings.map((f) => f.acted_by)).toEqual([{ user_id: BOB, name: 'Bob' }, null]);
    expect(legacy!.started_by).toBeNull();
  });
});
