import type { GitLabTokenCheck, Settings } from '@devdigest/shared';

/** A persisted settings key/value row (non-secret prefs). */
export interface SettingsRow {
  key: string;
  value: unknown;
}

/** Collapse key/value setting rows into a flat `Settings` object. */
export function rowsToSettings(rows: SettingsRow[]): Settings {
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out as Settings;
}

/** Translate a GitLab token check into the connection-test outcome (AC-2..AC-5). */
export function gitlabCheckToResult(check: GitLabTokenCheck): { ok: boolean; message: string } {
  if (!check.ok) return { ok: false, message: `GitLab token is ${check.reason}` };
  if (check.missingScopes.length > 0) {
    return { ok: false, message: `Missing scopes: ${check.missingScopes.join(', ')}` };
  }
  const connected = `Connected as @${check.username}`;
  if (check.scopes === null) {
    return {
      ok: true,
      message: `${connected} (scope sufficiency is verified on first repo access)`,
    };
  }
  return { ok: true, message: connected };
}
