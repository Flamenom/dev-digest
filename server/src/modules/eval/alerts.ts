/**
 * L06 Eval Pipeline — the alert banner rules. THE WHOLE OF SPEC §8.4, and
 * nothing else.
 *
 * ---------------------------------------------------------------------------
 * PURE. Two aggregated batches in, one structured alert (or `null`) out.
 * ---------------------------------------------------------------------------
 * ZERO LLM calls, zero I/O, zero framework, zero imports beyond the shared Zod
 * contracts and this slice's `constants.ts`. Mechanically enforced by the
 * `eval-scoring-purity` rule in `.dependency-cruiser.cjs` (`pnpm arch`,
 * `error`-severity): nothing here may reach `db/`, `adapters/`, `fastify` or
 * the composition root. Onion §2 — an alert is a DECISION RULE, so it sits
 * inward even though it lives inside a feature slice.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OUTPUT IS STRUCTURED AND NOT A SENTENCE
 * ---------------------------------------------------------------------------
 * `buildAlert` returns `EvalAlertDetail` (C16): a tone, a primary signal, the
 * remaining signals and two booleans. The client renders that through
 * next-intl. `alertFallbackSentence` exists ONLY because the frozen
 * `EvalDashboard.alert` is `z.string().nullable()` and must be filled with
 * something honest — it is a compatibility filler for a frozen contract, never
 * the UI's source of truth (§2.2, §8.4).
 *
 * ---------------------------------------------------------------------------
 * TWO TRAPS THAT TRAVEL WITH THIS CODE
 * ---------------------------------------------------------------------------
 *  1. ROUNDING. `Math.round` is half-UP, not half-away-from-zero:
 *     `Math.round(-2.5) === -2` while `Math.round(2.5) === 3`. A −2.5 pt
 *     precision drop would therefore read as a non-significant −2 while the
 *     mirror-image +2.5 pt gain reads as a significant +3 — the threshold
 *     would be asymmetric around zero, and the asymmetry would sit exactly on
 *     the regression side the harness exists to catch. Hence
 *     `roundHalfAwayFromZero`.
 *  2. TIE-BREAKING. Ties break `precision > recall > citation_accuracy` (§8.4
 *     rule 5). That is implemented as an EXPLICIT, FIXED iteration order plus a
 *     strict `>` comparison, never `Array.prototype.sort` — a comparator that
 *     returns 0 for a tie leaves the outcome to the engine's sort stability,
 *     which is the wrong thing to depend on for a rule this load-bearing.
 */

import type { EvalAlertDetail, EvalAlertSignal } from '@devdigest/shared';
import { ALERT_THRESHOLD_PTS } from './constants.js';

// ===========================================================================
// Plain-data input — structural, so nothing outward has to be imported
// ===========================================================================

/** The three metrics the alert rules read, plus the §8.4 rule-8 tie-in. */
export type EvalAlertMetric = EvalAlertSignal['metric'];

/**
 * The only part of an aggregated batch §8.4 reads. Declared structurally so
 * this module imports neither a DB row type nor the repository; both
 * `EvalBatchRecord` (C10) and `scoring.ts`'s `BatchAggregate` satisfy it.
 */
export interface AlertBatchInput {
  recall: number | null;
  precision: number | null;
  citation_accuracy: number | null;
  /** Rule 8: a precision drop only means "a new false positive" if noise rose. */
  noise_findings: number;
  /** Surfaced on the banner as `on v7`; absent on a pre-0018 row. */
  agent_version?: number | null;
}

/**
 * §8.4 rule 5 — the fixed tie-break order. A precision regression is the
 * false-positive signal the harness exists to catch, so it outranks the other
 * two at equal magnitude. Iteration order IS the tie-break; do not sort.
 */
export const ALERT_METRIC_PRIORITY: readonly EvalAlertMetric[] = [
  'precision',
  'recall',
  'citation_accuracy',
];

// ===========================================================================
// §8.4 rule 2 — delta in points, rounded half away from zero
// ===========================================================================

/**
 * `round((head − base) × 100)`, HALF AWAY FROM ZERO (§8.4 rule 2).
 *
 * The `× 100` is done in binary floating point, so an exact-decimal input pair
 * can land a hair below the .5 boundary (`0.8 - 0.775` is `0.02500000000000002`,
 * and a different pair can be `…4999999999999996`). The `1e6` pre-round wipes
 * that dust — it cannot move any value that is not already within 5e-7 of the
 * boundary, so it changes no real result; it only makes the boundary behave the
 * way the decimal spec says it does.
 */
export function deltaPoints(head: number, base: number): number {
  const scaled = (head - base) * 100;
  const cleaned = Math.round(scaled * 1e6) / 1e6;
  return Math.sign(cleaned) * Math.round(Math.abs(cleaned));
}

// ===========================================================================
// §8.4 rules 1–8 — the whole banner decision
// ===========================================================================

/**
 * Build the alert for one agent's window, or `null` for "no banner".
 *
 * `head` is the newest complete batch in the window, `base` the one before it
 * (same agent, same window). Either being missing means the window holds fewer
 * than two complete batches, which is §8.4 rule 1 — `null`, no banner. The
 * caller therefore does not have to count batches itself; it hands over what it
 * found and this function decides.
 *
 * The eight rules, in the order they are applied below:
 *  1. < 2 complete batches → `null`.
 *  2. per metric: skip when either side is `null`, else `delta_pts` (above).
 *  3. significant iff `|delta_pts| >= ALERT_THRESHOLD_PTS`.
 *  4. no significant metric → `null`.
 *  5. `primary` = largest `|delta_pts|`; ties → precision > recall > citation.
 *  6. `tone` = `warn` when the primary moved down, else `info`.
 *  7. `others` = the rest, in the same priority order.
 *  8. `new_false_positive` iff the primary is a precision DROP and noise ROSE.
 */
export function buildAlert(
  head: AlertBatchInput | null | undefined,
  base: AlertBatchInput | null | undefined,
): EvalAlertDetail | null {
  // Rule 1 — fewer than two complete batches in the window.
  if (!head || !base) return null;

  // Rules 2 + 3 — collect the significant movers, in priority order.
  const signals: EvalAlertSignal[] = [];
  for (const metric of ALERT_METRIC_PRIORITY) {
    const h = head[metric];
    const b = base[metric];
    // Rule 2 — a null on either side means the metric had a zero denominator
    // on that run (§4.6); comparing it against anything would invent a number.
    if (h === null || b === null) continue;
    const delta_pts = deltaPoints(h, b);
    // Rule 3 — sub-threshold moves are noise, not news.
    if (Math.abs(delta_pts) < ALERT_THRESHOLD_PTS) continue;
    signals.push({ metric, direction: delta_pts < 0 ? 'down' : 'up', delta_pts });
  }

  // Rule 4 — nothing moved enough to be worth a banner.
  const [firstSignal, ...restSignals] = signals;
  if (!firstSignal) return null;

  // Rule 5 — largest absolute mover. `signals` is already in priority order and
  // the comparison is STRICT, so an equal magnitude never displaces the
  // higher-priority metric already held. That is the whole tie-break.
  let primary = firstSignal;
  for (const signal of restSignals) {
    if (Math.abs(signal.delta_pts) > Math.abs(primary.delta_pts)) primary = signal;
  }

  // Rule 7 — everything else, still in priority order.
  const others = signals.filter((signal) => signal.metric !== primary.metric);

  return {
    // Rule 6.
    tone: primary.direction === 'down' ? 'warn' : 'info',
    primary,
    others,
    // Rule 8 — without a rise in noise findings the clause is omitted, because
    // precision can also fall simply because the agent said less overall.
    new_false_positive:
      primary.metric === 'precision' &&
      primary.direction === 'down' &&
      head.noise_findings > base.noise_findings,
    head_version: head.agent_version ?? null,
  };
}

// ===========================================================================
// The frozen-contract fallback sentence (§8.4, last paragraph)
// ===========================================================================

/** Lower-case display words; `citation_accuracy` shortens to `citation` (§8.4). */
const METRIC_WORD: Record<EvalAlertMetric, string> = {
  recall: 'recall',
  precision: 'precision',
  citation_accuracy: 'citation',
};

function capitalize(s: string): string {
  return s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

/** `1pt` / `2pts` — the design's own spacing, no space before the unit. */
function points(deltaPts: number): string {
  const magnitude = Math.abs(deltaPts);
  return `${magnitude}${magnitude === 1 ? 'pt' : 'pts'}`;
}

/** `recall and citation` / `recall, citation and precision` — Oxford-less list. */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function othersSentence(others: readonly EvalAlertSignal[]): string {
  if (others.length === 0) return '';
  const allUp = others.every((s) => s.direction === 'up');
  const allDown = others.every((s) => s.direction === 'down');
  if (allUp || allDown) {
    const direction = allUp ? 'up' : 'down';
    const both = others.length === 2 ? 'both ' : others.length > 2 ? 'all ' : '';
    return capitalize(`${joinWords(others.map((s) => METRIC_WORD[s.metric]))} ${both}${direction}.`);
  }
  // Mixed directions: spell each one out rather than pick a misleading verb.
  return capitalize(`${others.map((s) => `${METRIC_WORD[s.metric]} ${s.direction}`).join(', ')}.`);
}

/**
 * The plain-English fallback carried by the frozen `EvalDashboard.alert`
 * (`z.string().nullable()`), which cannot hold `EvalAlertDetail`.
 *
 * THE CLIENT IGNORES THIS STRING. It renders C16 through next-intl, so the
 * banner is localisable and every metric change carries a glyph AND text
 * (AC-44). Changing the wording here changes no UI; it changes an API field
 * kept honest for non-UI consumers.
 *
 * The design's reference banner is reproduced exactly:
 *   "Precision dipped 2pts on v7 — a new false positive slipped in.
 *    Recall and citation both up."
 */
export function alertFallbackSentence(detail: EvalAlertDetail): string {
  const { primary } = detail;
  const verb = primary.direction === 'down' ? 'dipped' : 'rose';
  const version = detail.head_version == null ? '' : ` on v${detail.head_version}`;
  const clause = detail.new_false_positive ? ' — a new false positive slipped in' : '';

  const head = `${capitalize(METRIC_WORD[primary.metric])} ${verb} ${points(primary.delta_pts)}${version}${clause}.`;
  const tail = othersSentence(detail.others);
  return tail === '' ? head : `${head} ${tail}`;
}
