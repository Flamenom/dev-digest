/** Pure helpers for RunReviewDropdown. */
import type { DropdownItemDef } from "@devdigest/ui";
import { NO_ENABLED_AGENTS } from "./constants";

/** The server's "Run all with no enabled agent" 409 — matched by SHAPE, not `instanceof`. */
export function isNoEnabledAgentsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown };
  return e.status === 409 && e.code === NO_ENABLED_AGENTS;
}

type AgentOption = { id: string; name: string; model: string; enabled: boolean };

/** The zero-agents entry: none while loading (no flash of a role-less hint), else role-specific. */
export function zeroStateItem(opts: {
  pending: boolean;
  isAdmin: boolean;
  adminLabel: string;
  memberLabel: string;
  onCreate: () => void;
}): DropdownItemDef | null {
  if (opts.pending) return null;
  if (opts.isAdmin) return { label: opts.adminLabel, icon: "Plus", muted: true, onClick: opts.onCreate };
  return { label: opts.memberLabel, icon: "Lock", muted: true, disabled: true };
}

/** EVERY agent (not just enabled) — a specific agent runs regardless of its enabled flag. */
export function agentMenuItems(
  agents: AgentOption[],
  onRun: (agentId: string) => void,
  zeroState: DropdownItemDef | null,
): DropdownItemDef[] {
  if (agents.length > 0) {
    return agents.map((a) => ({
      label: a.name,
      icon: "Cpu" as const,
      hint: a.enabled ? a.model : `${a.model} · disabled`,
      onClick: () => onRun(a.id),
    }));
  }
  return zeroState ? [zeroState] : [];
}

/** "Run all": actionable with an enabled agent, else inert (AC-58) with a hint once the list loaded. */
export function runAllItem(opts: {
  hasEnabled: boolean;
  loaded: boolean;
  label: string;
  disabledReason: string;
  onRun: () => void;
}): DropdownItemDef {
  if (opts.hasEnabled) return { label: opts.label, icon: "Play", onClick: opts.onRun };
  return {
    label: opts.label,
    icon: "Play",
    muted: true,
    // Inert (focusable, aria-disabled, no request). The hint waits for the
    // list so a loading dropdown doesn't flash "no agent enabled".
    disabled: true,
    ...(opts.loaded ? { disabledReason: opts.disabledReason } : {}),
  };
}
