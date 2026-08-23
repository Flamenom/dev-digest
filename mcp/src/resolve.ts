/* resolve.ts — human-friendly identifiers → API rows. Pure logic over the
   injected DevDigestApi: repo full name / PR number / agent name are what
   Claude passes; every downstream endpoint is keyed by row uuid. Failures are
   ResolveError with forward-leading text (valid values listed) — the tool
   layer maps them via toToolError, so nothing here reaches MCP as a throw. */

import type { AgentListItem, PrMeta, Repo } from '@devdigest/shared';
import type { DevDigestApi } from './api.js';
import { ResolveError, notFoundHint } from './errors.js';

/**
 * Resolve a repo by uuid (exact) → full_name (case-insensitive) → unique name
 * suffix. Ambiguous or missing → ResolveError listing known full_names.
 */
export async function resolveRepo(api: DevDigestApi, repo: string): Promise<Repo> {
  const repos = await api.get<Repo[]>('/repos');
  const byId = repos.find((r) => r.id === repo);
  if (byId) return byId;

  const needle = repo.toLowerCase();
  const byFullName = repos.find((r) => r.full_name.toLowerCase() === needle);
  if (byFullName) return byFullName;

  const bySuffix = repos.filter((r) => r.name.toLowerCase() === needle);
  if (bySuffix.length === 1) return bySuffix[0]!;

  const known = notFoundHint('repos', repos.map((r) => r.full_name));
  if (bySuffix.length > 1) {
    throw new ResolveError(
      `Repo "${repo}" is ambiguous — use the full name. ${notFoundHint(
        'matches',
        bySuffix.map((r) => r.full_name),
      )}`,
    );
  }
  throw new ResolveError(`Repo "${repo}" not found. ${known}`);
}

/**
 * Resolve a PR by its GitHub number within a repo. `repoLabel` is only used in
 * the error text (pass the repo full_name for readable guidance).
 */
export async function resolvePull(
  api: DevDigestApi,
  repoId: string,
  pr: number,
  repoLabel: string = repoId,
): Promise<PrMeta & { id: string }> {
  const pulls = await api.get<PrMeta[]>(`/repos/${encodeURIComponent(repoId)}/pulls`);
  const match = pulls.find((p) => p.number === pr);
  if (match) {
    if (match.id == null) {
      throw new ResolveError(
        `PR #${pr} in ${repoLabel} has no internal id yet — refresh the repo in the DevDigest UI and retry.`,
      );
    }
    return { ...match, id: match.id };
  }
  const numbers = pulls.map((p) => `#${p.number}`).join(', ');
  throw new ResolveError(
    numbers.length > 0
      ? `PR #${pr} not found in ${repoLabel} — open PRs: ${numbers}.`
      : `PR #${pr} not found in ${repoLabel} — the repo has no pull requests yet.`,
  );
}

/**
 * Resolve an agent by uuid (exact) → name (case-insensitive). Missing →
 * ResolveError listing valid agent names + pointing at devdigest_list_agents.
 */
export async function resolveAgent(api: DevDigestApi, agent: string): Promise<AgentListItem> {
  const agents = await api.get<AgentListItem[]>('/agents');
  const byId = agents.find((a) => a.id === agent);
  if (byId) return byId;

  const needle = agent.toLowerCase();
  const byName = agents.find((a) => a.name.toLowerCase() === needle);
  if (byName) return byName;

  throw new ResolveError(
    `Agent "${agent}" not found. ${notFoundHint(
      'agents',
      agents.map((a) => a.name),
    )} Call devdigest_list_agents for details.`,
  );
}
