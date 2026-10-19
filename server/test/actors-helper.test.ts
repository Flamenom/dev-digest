import { describe, it, expect, vi } from 'vitest';
import type { ActorRefValue } from '@devdigest/shared';
import { withActors } from '../src/modules/_shared/actors.js';

/** Rec-3 — DTO actor enrichment with one batched lookup. */

interface RunDto {
  id: string;
  initiatedBy: string | null;
  cancelledBy?: string;
}

const directory = new Map<string, ActorRefValue>([
  ['u-1', { user_id: 'u-1', name: 'Ada' }],
  ['sys', { user_id: 'sys', name: 'You', is_system: true }],
]);

function fakeLookup() {
  return vi.fn(async (ids: readonly string[]) => {
    const out = new Map<string, ActorRefValue>();
    for (const id of ids) {
      const ref = directory.get(id);
      if (ref) out.set(id, ref);
    }
    return out;
  });
}

describe('withActors', () => {
  it('resolves every field with one de-duplicated lookup; null/unknown ids → null ref', async () => {
    const lookup = fakeLookup();
    const dtos: RunDto[] = [
      { id: 'r1', initiatedBy: 'u-1', cancelledBy: 'sys' },
      { id: 'r2', initiatedBy: null },
      { id: 'r3', initiatedBy: 'ghost', cancelledBy: 'u-1' },
    ];

    const out = await withActors(
      dtos,
      { started_by: (d) => d.initiatedBy, cancelled_by: (d) => d.cancelledBy },
      lookup,
    );

    expect(lookup).toHaveBeenCalledTimes(1);
    expect([...lookup.mock.calls[0]![0]].sort()).toEqual(['ghost', 'sys', 'u-1']);
    expect(out).toEqual([
      {
        id: 'r1',
        initiatedBy: 'u-1',
        cancelledBy: 'sys',
        started_by: { user_id: 'u-1', name: 'Ada' },
        cancelled_by: { user_id: 'sys', name: 'You', is_system: true },
      },
      { id: 'r2', initiatedBy: null, started_by: null, cancelled_by: null },
      {
        id: 'r3',
        initiatedBy: 'ghost',
        cancelledBy: 'u-1',
        started_by: null,
        cancelled_by: { user_id: 'u-1', name: 'Ada' },
      },
    ]);
    // Inputs are not mutated.
    expect(dtos[1]).toEqual({ id: 'r2', initiatedBy: null });
  });

  it('skips the lookup entirely when no DTO carries an actor', async () => {
    const lookup = fakeLookup();
    const out = await withActors([{ id: 'a', by: null as string | null }], { created_by: (d) => d.by }, lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(out).toEqual([{ id: 'a', by: null, created_by: null }]);
    expect(await withActors([], { created_by: () => 'u-1' }, lookup)).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
});
