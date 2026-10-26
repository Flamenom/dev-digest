/* helpers.ts — pure rules of the publish confirm dialog for outdated
   ("deprecated") runs (spec 2026-10-23-gitlab-publish-outdated-findings,
   AC-21 – AC-23). No React, no I/O. */
import type { PublishDeprecation, PublishLiveDeprecation, PublishPlan } from "@/lib/types";
import { shortSha } from "../helpers";

/** The deprecation the dialog shows: the live one when the plan has it, else the preview's. */
export type DialogDeprecation = PublishDeprecation & { live_head_sha?: PublishLiveDeprecation["live_head_sha"] };

/**
 * Effective deprecation (AC-22): `plan.deprecation` when the plan was read,
 * otherwise (plan loading or unavailable) the preview's review-level one.
 */
export function effectiveDeprecation(
  plan: PublishPlan | undefined,
  preview: PublishDeprecation | null | undefined,
): DialogDeprecation | null {
  if (plan?.plan_available) return plan.deprecation ?? null;
  return preview ?? null;
}

/** Which reason line the warning renders, with its short SHAs (Q6: non-hex → `head_unknown` wording). */
export type ReasonLine =
  | { kind: "headMoved"; sha: string; liveSha: string }
  | { kind: "headMovedNoLive"; sha: string }
  | { kind: "headUnknown" };

export function reasonLine(deprecation: DialogDeprecation): ReasonLine {
  const sha = deprecation.reason === "head_moved" ? shortSha(deprecation.reviewed_head_sha) : null;
  if (!sha) return { kind: "headUnknown" };
  const liveSha = shortSha(deprecation.live_head_sha);
  return liveSha ? { kind: "headMoved", sha, liveSha } : { kind: "headMovedNoLive", sha };
}

/** The placement line (AC-22): `K of N`, `All N`, or the plan-failure line. */
export type PlacementLine =
  | { kind: "some"; general: number; total: number }
  | { kind: "all"; total: number }
  | { kind: "unavailable" };

export function placementLine(plan: PublishPlan | undefined): PlacementLine | null {
  if (!plan) return null; // still loading
  if (!plan.plan_available || !plan.placement) return { kind: "unavailable" };
  const { positioned, general } = plan.placement;
  const total = positioned + general;
  return total > 0 && general === total ? { kind: "all", total } : { kind: "some", general, total };
}
