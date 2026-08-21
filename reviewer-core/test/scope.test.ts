import { describe, it, expect } from 'vitest';
import type { ScopedFinding } from '@devdigest/shared';
import { applyScopeFilter, OUT_OF_SCOPE_KEPT_PREFIX } from '../src/index.js';

/**
 * applyScopeFilter (L03) — pure scope policy, applied after grounding and
 * before the deterministic re-score. Locked decisions under test:
 *  - untagged / 'in' findings pass through unchanged (scope key stripped);
 *  - non-CRITICAL 'out' findings are ALL dropped, each with a reason;
 *  - among CRITICAL 'out' findings exactly ONE survives (severity → confidence
 *    desc → stable order) with the deterministic rationale prefix — intent can
 *    never fully silence a severe defect.
 */

const base = (over: Partial<ScopedFinding>): ScopedFinding => ({
  id: 'f',
  severity: 'WARNING',
  category: 'bug',
  title: 't',
  file: 'src/config.ts',
  start_line: 11,
  end_line: 11,
  rationale: 'rationale text',
  confidence: 0.8,
  kind: 'finding',
  ...over,
});

describe('applyScopeFilter', () => {
  it('all-in-scope / untagged findings pass through unchanged, scope key stripped, nothing dropped', () => {
    const input: ScopedFinding[] = [
      base({ id: 'f1', scope: 'in', severity: 'CRITICAL' }),
      base({ id: 'f2' }), // untagged
      base({ id: 'f3', scope: null, severity: 'SUGGESTION' }),
    ];

    const { kept, dropped } = applyScopeFilter(input);

    expect(dropped).toEqual([]);
    expect(kept.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    // Rationales untouched, and the DB/API only ever see frozen Findings.
    for (const f of kept) {
      expect(f.rationale).toBe('rationale text');
      expect('scope' in f).toBe(false);
    }
  });

  it('non-CRITICAL out-of-scope findings are ALL dropped, each with a severity-naming reason', () => {
    const input: ScopedFinding[] = [
      base({ id: 'in1', scope: 'in' }),
      base({ id: 'out-warn', scope: 'out', severity: 'WARNING' }),
      base({ id: 'out-sugg', scope: 'out', severity: 'SUGGESTION' }),
    ];

    const { kept, dropped } = applyScopeFilter(input);

    expect(kept.map((f) => f.id)).toEqual(['in1']);
    expect(dropped.map((d) => d.finding.id)).toEqual(['out-warn', 'out-sugg']);
    expect(dropped[0]!.reason).toContain('severity WARNING');
    expect(dropped[1]!.reason).toContain('severity SUGGESTION');
    for (const d of dropped) {
      expect(d.reason).toContain('out of declared PR scope');
      expect('scope' in d.finding).toBe(false);
    }
  });

  it('multiple CRITICAL out → exactly ONE survives: confidence desc, then stable order; prefix added; scope stripped', () => {
    const input: ScopedFinding[] = [
      base({ id: 'out-low', scope: 'out', severity: 'CRITICAL', confidence: 0.5 }),
      base({ id: 'out-high-1', scope: 'out', severity: 'CRITICAL', confidence: 0.9 }),
      base({ id: 'out-high-2', scope: 'out', severity: 'CRITICAL', confidence: 0.9 }), // tie → first-seen wins
      base({ id: 'out-warn', scope: 'out', severity: 'WARNING', confidence: 0.99 }),
      base({ id: 'in1', scope: 'in', severity: 'SUGGESTION' }),
    ];

    const { kept, dropped } = applyScopeFilter(input);

    // Exactly one out-of-scope survivor: highest confidence, stable on the tie.
    expect(kept.map((f) => f.id)).toEqual(['out-high-1', 'in1']);
    const survivor = kept.find((f) => f.id === 'out-high-1')!;
    expect(survivor.rationale).toBe(`${OUT_OF_SCOPE_KEPT_PREFIX}rationale text`);
    expect(survivor.rationale.startsWith('**[Out of declared PR scope')).toBe(true);

    // The other CRITICAL outs are dropped with the "another CRITICAL kept" reason.
    expect(dropped.map((d) => d.finding.id)).toEqual(['out-low', 'out-high-2', 'out-warn']);
    expect(dropped[0]!.reason).toContain('another CRITICAL finding was kept');
    expect(dropped[1]!.reason).toContain('another CRITICAL finding was kept');
    expect(dropped[2]!.reason).toContain('only CRITICAL out-of-scope findings survive');

    // `scope` never leaks past the filter, kept or dropped.
    for (const f of [...kept, ...dropped.map((d) => d.finding)]) {
      expect('scope' in f).toBe(false);
    }
    // Non-survivor rationales stay untouched (no prefix).
    expect(dropped[0]!.finding.rationale).toBe('rationale text');
  });

  it('empty input → empty output (no survivor invented)', () => {
    expect(applyScopeFilter([])).toEqual({ kept: [], dropped: [] });
  });
});
