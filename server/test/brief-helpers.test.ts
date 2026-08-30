/**
 * Pure helpers of the PR Brief slice (`modules/brief/helpers.ts`) — the cache
 * fingerprint (AC-4, AC-41), the allowed-reference set (AC-10) and the grounding
 * gate over model output (AC-11, AC-12, AC-13), plus the nullable spend sum
 * behind `BriefRepository.getPrSpend` (AC-19).
 *
 * Hermetic: no DB, no fastify, no Docker (smart-diff-helpers.test.ts style).
 */
import { describe, it, expect } from 'vitest';
import type { BriefRisk, PrBriefGeneration, ReviewFocusEntry } from '@devdigest/shared';
import {
  buildAllowedRefs,
  changeTypeFromPatch,
  changedLineRangesFromPatch,
  computeInputFingerprint,
  groundGeneration,
  mergeMissingInputs,
  staleReason,
  sumSpend,
  type AllowedRefsBlastInput,
  type FingerprintInput,
} from '../src/modules/brief/helpers.js';

// ---------------------------------------------------------------- fixtures

/** `src/app.ts` is changed at lines 12–15 and 40–41; nothing else moved. */
const APP_PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,3 +12,4 @@ export function register() {',
  '+  registerBrief(app);',
  '@@ -38,2 +40,2 @@ function boot() {',
  '-  old();',
  '+  fresh();',
].join('\n');

/** A blast response whose only caller line is `src/legacy/caller.ts:88`. */
const BLAST: AllowedRefsBlastInput = {
  status: 'ok',
  symbols: [
    {
      symbol: { file: 'src/app.ts' },
      callers: [{ file: 'src/legacy/caller.ts', line: 88 }],
    },
    // A changed symbol whose file has NO caller: contributes a path, no line (Q3).
    { symbol: { file: 'src/legacy/declared-only.ts' }, callers: [] },
  ],
  endpoints: [{ file: 'src/legacy/endpoint.ts' }],
};

/** The PR's own grounded findings: their ids are the only ones a focus entry may cite ([D3]). */
const FINDING_ID = 'f1000000-0000-4000-8000-00000000000a';

const allowed = () =>
  buildAllowedRefs({
    changedFiles: [{ path: 'src/app.ts', patch: APP_PATCH }],
    blast: BLAST,
    findings: [{ id: FINDING_ID, path: 'src/app.ts' }],
  });

const risk = (over: Partial<BriefRisk> = {}): BriefRisk => ({
  kind: 'auth',
  title: 'Auth surface touched',
  explanation: 'The registration path now runs before the tenancy check.',
  severity: 'high',
  refs: [{ path: 'src/app.ts', start_line: 12, end_line: 15 }],
  ...over,
});

const focus = (over: Partial<ReviewFocusEntry> = {}): ReviewFocusEntry => ({
  path: 'src/app.ts',
  line: 12,
  reason: 'New wiring runs before tenancy is resolved.',
  finding_id: null,
  ...over,
});

const generation = (over: Partial<PrBriefGeneration> = {}): PrBriefGeneration => ({
  what: 'Wires the brief module into the app.',
  why: 'The Overview tab needs one composed answer.',
  risks: [risk()],
  review_focus: [focus()],
  ...over,
});

// ------------------------------------------------------------ patch headers

describe('patch-header projections', () => {
  it('reads changed NEW-FILE ranges from `@@` headers only, never a hunk body', () => {
    expect(changedLineRangesFromPatch(APP_PATCH)).toEqual([
      { start: 12, end: 15 },
      { start: 40, end: 41 },
    ]);
    // A pure-deletion hunk adds no new-file line; a count-less header means one line.
    expect(changedLineRangesFromPatch('@@ -5,4 +7,0 @@\n@@ -20,1 +30 @@')).toEqual([
      { start: 30, end: 30 },
    ]);
    expect(changedLineRangesFromPatch(null)).toEqual([]);
  });

  it('derives the change type from the header, defaulting to `modified` (Q2)', () => {
    expect(changeTypeFromPatch('new file mode 100644\n@@ -0,0 +1,3 @@')).toBe('added');
    expect(changeTypeFromPatch('deleted file mode 100644\n@@ -1,3 +0,0 @@')).toBe('deleted');
    expect(changeTypeFromPatch('rename from old.ts\nrename to new.ts')).toBe('renamed');
    expect(changeTypeFromPatch(APP_PATCH)).toBe('modified');
    expect(changeTypeFromPatch(null)).toBe('modified');
    // Text that merely LOOKS like a header inside a hunk body is not a change type.
    expect(changeTypeFromPatch('@@ -1,2 +1,2 @@\n+new file mode 100644')).toBe('modified');
  });
});

// ------------------------------------------------------- allowed-reference set

describe('buildAllowedRefs (AC-10)', () => {
  it('unions diff, blast and finding paths, and indexes their citable lines', () => {
    const refs = allowed();
    expect([...refs.files].sort()).toEqual([
      'src/app.ts',
      'src/legacy/caller.ts',
      'src/legacy/declared-only.ts',
      'src/legacy/endpoint.ts',
    ]);
    expect(refs.diffLines.get('src/app.ts')).toEqual([
      { start: 12, end: 15 },
      { start: 40, end: 41 },
    ]);
    expect([...(refs.blastLines.get('src/legacy/caller.ts') ?? [])]).toEqual([88]);
    // Q3: a symbol-declaration / endpoint file reports no line at all.
    expect(refs.blastLines.has('src/legacy/declared-only.ts')).toBe(false);
    expect(refs.blastLines.has('src/legacy/endpoint.ts')).toBe(false);
    // [D3]: the ids a review-focus entry may claim to correspond to.
    expect([...refs.findingIds]).toEqual([FINDING_ID]);
  });

  it('narrows to diff + finding files when the blast response is degraded (AC-33)', () => {
    const refs = buildAllowedRefs({
      changedFiles: [{ path: 'src/app.ts', patch: APP_PATCH }],
      blast: { ...BLAST, status: 'degraded' },
      findings: [{ id: FINDING_ID, path: 'src/found-only.ts' }],
    });
    expect([...refs.files].sort()).toEqual(['src/app.ts', 'src/found-only.ts']);
    expect(refs.blastLines.size).toBe(0);
    // Findings are an independent input: a degraded blast does not narrow them.
    expect([...refs.findingIds]).toEqual([FINDING_ID]);
  });
});

// -------------------------------------------------------------- grounding gate

describe('groundGeneration (AC-11, AC-12, AC-13)', () => {
  it('drops an invented path and keeps the grounded one (AC-11)', () => {
    const grounded = groundGeneration(
      generation({
        risks: [
          risk({ title: 'Invented', refs: [{ path: 'src/does-not-exist.ts', start_line: 3 }] }),
          risk({ title: 'Real' }),
        ],
        review_focus: [focus({ path: 'src/does-not-exist.ts', line: 3 }), focus()],
      }),
      allowed(),
    );
    expect(grounded.risks.map((r) => r.title)).toEqual(['Real']);
    expect(grounded.review_focus.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('keeps only refs whose path is allowed, and drops a risk left with none (AC-11)', () => {
    const grounded = groundGeneration(
      generation({
        risks: [
          risk({
            refs: [
              { path: 'src/app.ts', start_line: 12 },
              { path: 'src/does-not-exist.ts', start_line: 1 },
            ],
          }),
        ],
        review_focus: [],
      }),
      allowed(),
    );
    expect(grounded.risks).toHaveLength(1);
    expect(grounded.risks[0]!.refs.map((r) => r.path)).toEqual(['src/app.ts']);
  });

  it('drops a focus entry on a changed file at an UNCHANGED line (AC-12)', () => {
    const grounded = groundGeneration(
      generation({
        review_focus: [
          focus({ line: 12 }), // inside the first changed hunk → kept
          focus({ line: 41 }), // inside the second changed hunk → kept
          focus({ line: 25 }), // real file, untouched line → dropped
        ],
      }),
      allowed(),
    );
    expect(grounded.review_focus.map((f) => f.line)).toEqual([12, 41]);
  });

  it('keeps a blast CALLER line and drops a blast file with no caller line (AC-12, Q3)', () => {
    const grounded = groundGeneration(
      generation({
        // A path-scoped risk ref on the line-less blast file still survives (AC-11).
        risks: [risk({ refs: [{ path: 'src/legacy/declared-only.ts', start_line: 1 }] })],
        review_focus: [
          focus({ path: 'src/legacy/caller.ts', line: 88 }), // reported caller line → kept
          focus({ path: 'src/legacy/caller.ts', line: 89 }), // same file, other line → dropped
          focus({ path: 'src/legacy/declared-only.ts', line: 1 }), // no line reported → dropped
          focus({ path: 'src/legacy/endpoint.ts', line: 1 }), // endpoints are line-less → dropped
        ],
      }),
      allowed(),
    );
    expect(grounded.risks).toHaveLength(1);
    expect(grounded.review_focus).toEqual([
      expect.objectContaining({ path: 'src/legacy/caller.ts', line: 88 }),
    ]);
  });

  it('persists a fully discarded section as [] with the key still present (AC-13)', () => {
    const grounded = groundGeneration(
      generation({
        risks: [risk({ refs: [{ path: 'nope/a.ts', start_line: 1 }] })],
        review_focus: [focus({ path: 'nope/a.ts', line: 1 })],
      }),
      allowed(),
    );
    expect(grounded).toEqual({ risks: [], review_focus: [] });
    expect(Object.keys(grounded).sort()).toEqual(['review_focus', 'risks']);
  });

  it('nulls an unrecognised `finding_id` but KEEPS the entry, and keeps a known id ([D3])', () => {
    const grounded = groundGeneration(
      generation({
        review_focus: [
          // Groundable path+line, and the id names one of the PR's own findings.
          focus({ line: 12, finding_id: FINDING_ID }),
          // Same groundable path+line, but the id was invented (or belongs to
          // another PR): the id is dropped, the navigable reference survives.
          focus({ line: 41, finding_id: 'f9999999-0000-4000-8000-00000000ffff' }),
          // An entry the model sent with no id at all normalises to null.
          focus({ line: 40, finding_id: undefined }),
        ],
      }),
      allowed(),
    );

    // Non-vacuous: all three entries survive grounding, so the assertion below is
    // about the id itself and not about an entry that was dropped for its line.
    expect(grounded.review_focus).toHaveLength(3);
    expect(grounded.review_focus.map((f) => f.finding_id)).toEqual([FINDING_ID, null, null]);
    // Dropped, never repaired: the unknown id is not remapped to the real one.
    expect(JSON.stringify(grounded)).not.toContain('f9999999');
  });

  it("preserves the model's review-focus order — it is the reading order, never re-ranked", () => {
    const grounded = groundGeneration(
      generation({
        review_focus: [
          focus({ line: 41, reason: 'second-most important' }),
          focus({ line: 12, reason: 'read this next' }),
        ],
      }),
      allowed(),
    );
    expect(grounded.review_focus.map((f) => f.line)).toEqual([41, 12]);
  });
});

// ----------------------------------------------------------------- fingerprint

/**
 * The projection the service performs before hashing. Written out here so the
 * AC-41 test can mutate a realistic PR state (findings included) and show that
 * finding actions cannot reach the fingerprint.
 */
interface FakePrState {
  intent: { headSha: string; generatedAt: string } | null;
  blast: { status: 'ok' | 'degraded'; counts: FingerprintInput['blastCounts'] } | null;
  reviews: { id: string }[];
  findings: { id: string; acceptedAt: Date | null; dismissedAt: Date | null }[];
}

const fingerprintOf = (state: FakePrState): string =>
  computeInputFingerprint({
    intentHeadSha: state.intent?.headSha ?? null,
    intentGeneratedAt: state.intent?.generatedAt ?? null,
    blastStatus: state.blast?.status ?? null,
    blastCounts: state.blast?.counts ?? null,
    latestReviewIds: state.reviews.map((r) => r.id),
  });

const BASE_STATE: FakePrState = {
  intent: { headSha: 'aaaaaaa1111', generatedAt: '2026-08-27T10:00:00.000Z' },
  blast: { status: 'ok', counts: { symbols: 3, callers: 7, endpoints: 1, crons: 0 } },
  reviews: [{ id: 'review-a' }, { id: 'review-b' }],
  findings: [{ id: 'finding-1', acceptedAt: null, dismissedAt: null }],
};

describe('computeInputFingerprint (AC-4, AC-41)', () => {
  it('changes when the per-agent-latest review-id set changes (AC-4)', () => {
    const before = fingerprintOf(BASE_STATE);
    const afterNewRun = fingerprintOf({
      ...BASE_STATE,
      reviews: [{ id: 'review-a' }, { id: 'review-c' }],
    });
    expect(afterNewRun).not.toBe(before);

    // …and when the intent or the blast summary moves.
    expect(
      fingerprintOf({
        ...BASE_STATE,
        intent: { headSha: 'bbbbbbb2222', generatedAt: '2026-08-27T10:00:00.000Z' },
      }),
    ).not.toBe(before);
    expect(
      fingerprintOf({
        ...BASE_STATE,
        blast: { status: 'ok', counts: { symbols: 4, callers: 7, endpoints: 1, crons: 0 } },
      }),
    ).not.toBe(before);
  });

  it('does NOT change when a finding is accepted or dismissed (AC-41)', () => {
    const before = fingerprintOf(BASE_STATE);
    const afterDismiss = fingerprintOf({
      ...BASE_STATE,
      findings: [{ id: 'finding-1', acceptedAt: null, dismissedAt: new Date() }],
    });
    const afterAccept = fingerprintOf({
      ...BASE_STATE,
      findings: [{ id: 'finding-1', acceptedAt: new Date(), dismissedAt: null }],
    });
    expect(afterDismiss).toBe(before);
    expect(afterAccept).toBe(before);
  });

  it('is stable across review-id ordering and repeated calls', () => {
    expect(
      fingerprintOf({ ...BASE_STATE, reviews: [{ id: 'review-b' }, { id: 'review-a' }] }),
    ).toBe(fingerprintOf(BASE_STATE));
    expect(fingerprintOf(BASE_STATE)).toBe(fingerprintOf(BASE_STATE));
  });

  it('handles a PR with no intent and no blast (AC-32, AC-33) without collapsing states', () => {
    const bare = fingerprintOf({ ...BASE_STATE, intent: null, blast: null });
    expect(bare).toMatch(/^[0-9a-f]{64}$/);
    expect(bare).not.toBe(fingerprintOf(BASE_STATE));
  });
});

describe('staleReason (AC-5)', () => {
  const current = { headSha: 'ffffff9999', fingerprint: 'fp-new' };

  it('returns null when the cached state still matches', () => {
    expect(staleReason(current, { headSha: 'ffffff9999', fingerprint: 'fp-new' })).toBeNull();
  });

  it('names the head move and the input change, without regenerating anything', () => {
    const bothMoved = staleReason(current, { headSha: 'aaaaaa1111', fingerprint: 'fp-old' });
    expect(bothMoved).toContain('aaaaaa1');
    expect(bothMoved).toContain('ffffff9');
    expect(bothMoved).toContain('inputs changed');

    expect(staleReason(current, { headSha: 'ffffff9999', fingerprint: 'fp-old' })).not.toContain(
      'head moved',
    );
  });

  it('reports a pre-0016 row (no recorded state) as uncheckable rather than fresh', () => {
    expect(staleReason(current, { headSha: null, fingerprint: null })).toContain(
      'cannot be checked',
    );
  });
});

// ------------------------------------------------------------- missing inputs

describe('mergeMissingInputs — what a READ reports (AC-32, AC-33, AC-34, NFR-3)', () => {
  const note = (input: string, reason: string) => ({ input, reason });

  it('serves the persisted ONE-TIME notes the read cannot recompute', () => {
    // Only `regenerate` can observe these three, so without persistence they
    // would vanish on the very next GET.
    const merged = mergeMissingInputs(
      [note('blast_radius', 'live: the index is not built yet')],
      [
        note('linked_issue', 'issue #471 could not be fetched'),
        note('repo_doc', 'specs/thing.md could not be read'),
        note('diff_statistics', 'the input budget was reached'),
      ],
    );
    expect(merged.map((m) => m.input)).toEqual([
      'blast_radius',
      'linked_issue',
      'repo_doc',
      'diff_statistics',
    ]);
  });

  it('lets LIVE state win over a stale persisted note, and drops it when live is silent', () => {
    // Generated without an intent, but the PR has since been classified: the
    // persisted `intent` note must not resurrect.
    expect(
      mergeMissingInputs([], [note('intent', 'generated before classification')]).map(
        (m) => m.input,
      ),
    ).toEqual([]);

    // Still missing, but the reason is the freshly computed one.
    const merged = mergeMissingInputs(
      [note('blast_radius', 'live reason')],
      [note('blast_radius', 'reason recorded at generation time')],
    );
    expect(merged).toEqual([note('blast_radius', 'live reason')]);
  });
});

// ------------------------------------------------------------------- PR spend

describe('sumSpend — the null semantics behind BriefRepository.getPrSpend (AC-9, AC-19)', () => {
  it('returns null, never 0, when nothing has a recorded cost (AC-19)', () => {
    expect(
      sumSpend([
        { costUsd: null, tokensIn: null, tokensOut: null },
        { costUsd: null, tokensIn: 120, tokensOut: 30 },
      ]),
    ).toEqual({ costUsd: null, tokensIn: 120, tokensOut: 30 });

    // No rows at all (no run, no intent, no brief) → every metric null.
    expect(sumSpend([])).toEqual({ costUsd: null, tokensIn: null, tokensOut: null });
  });

  it('sums review runs + intent + brief rather than taking the latest (AC-9)', () => {
    const total = sumSpend([
      { costUsd: 0.01, tokensIn: 4000, tokensOut: 500 }, // review run 1
      { costUsd: 0.02, tokensIn: 4000, tokensOut: 500 }, // review run 2
      { costUsd: 0.003, tokensIn: 200, tokensOut: 40 }, // intent
      { costUsd: 0.007, tokensIn: 31, tokensOut: 260 }, // brief
    ]);
    expect(total.tokensIn).toBe(8231);
    expect(total.tokensOut).toBe(1300);
    // Float arithmetic: the sum is the point, not its binary representation.
    expect(total.costUsd).toBeCloseTo(0.04, 10);
  });

  it('keeps a real $0.00 distinguishable from "nothing recorded"', () => {
    expect(sumSpend([{ costUsd: 0, tokensIn: null, tokensOut: null }]).costUsd).toBe(0);
  });
});
