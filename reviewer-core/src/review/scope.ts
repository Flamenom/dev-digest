import type { Finding, ScopedFinding } from '@devdigest/shared';

/**
 * Scope filter — applied AFTER the grounding gate and BEFORE the deterministic
 * re-score, only when a declared PR intent was injected. Pure, no I/O.
 *
 * Rules (locked decisions, spec 04):
 *  - untagged / scope='in' findings are kept as-is;
 *  - scope='out' + severity CRITICAL: exactly ONE survives (highest severity,
 *    tiebreak confidence desc, then stable order) with a deterministic
 *    rationale prefix — intent can never fully silence a severe defect;
 *  - every other scope='out' finding is dropped WITH a reason (callers emit
 *    each drop as an event — never silent);
 *  - the `scope` key is stripped from kept findings, so the DB/API only ever
 *    see frozen `Finding`s.
 */

export const OUT_OF_SCOPE_KEPT_PREFIX =
  '**[Out of declared PR scope — kept as the single out-of-scope signal]** ';

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 2,
  WARNING: 1,
  SUGGESTION: 0,
};

export interface ScopeFilterResult {
  kept: Finding[];
  dropped: { finding: Finding; reason: string }[];
}

function stripScope(f: ScopedFinding): Finding {
  const { scope: _scope, ...rest } = f;
  return rest;
}

export function applyScopeFilter(findings: ScopedFinding[]): ScopeFilterResult {
  // Pick the single surviving out-of-scope signal among CRITICAL 'out' findings:
  // highest severity, then confidence desc, then stable (first-seen) order.
  let survivor: ScopedFinding | undefined;
  for (const f of findings) {
    if (f.scope !== 'out' || f.severity !== 'CRITICAL') continue;
    if (!survivor) {
      survivor = f;
      continue;
    }
    const rank = SEVERITY_RANK[f.severity] ?? 0;
    const survivorRank = SEVERITY_RANK[survivor.severity] ?? 0;
    if (rank > survivorRank || (rank === survivorRank && f.confidence > survivor.confidence)) {
      survivor = f;
    }
  }

  const kept: Finding[] = [];
  const dropped: { finding: Finding; reason: string }[] = [];
  for (const f of findings) {
    if (f.scope !== 'out') {
      kept.push(stripScope(f));
      continue;
    }
    if (f === survivor) {
      const plain = stripScope(f);
      kept.push({ ...plain, rationale: OUT_OF_SCOPE_KEPT_PREFIX + plain.rationale });
      continue;
    }
    dropped.push({
      finding: stripScope(f),
      reason:
        f.severity === 'CRITICAL'
          ? 'out of declared PR scope (another CRITICAL finding was kept as the single out-of-scope signal)'
          : `out of declared PR scope (severity ${f.severity} — only CRITICAL out-of-scope findings survive)`,
    });
  }

  return { kept, dropped };
}
