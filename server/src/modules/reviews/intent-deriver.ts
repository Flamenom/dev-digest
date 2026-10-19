import type {
  FeatureModelChoice,
  IntentDetail,
  IntentDetailWrite,
  IntentSource,
  IssueMeta,
  LLMProvider,
  Provider,
  PullRequestHost,
  RepoProvider,
  RepoRef,
  StoredIntentDetail,
} from '@devdigest/shared';
import { IntentClassification } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { hostRepoRef } from '../_shared/repo-ref.js';
import {
  computeConfidence,
  extractExternalUrls,
  extractIssueRef,
  extractRepoDocPaths,
  hunkHeadersFromPatch,
  toIntentDetail,
} from './intent-helpers.js';
import { buildIntentMessages } from './intent-prompts.js';

/**
 * L03 — Intent Layer derivation, as FREE FUNCTIONS (per spec: `deriveIntent()`
 * in reviews/intent-deriver.ts, not a service class). Classifies WHY a PR
 * exists (summary + in/out scope + risk areas) with one cheap structured LLM
 * call, persists it per PR, and serves it to the intent routes and the review
 * executor — both consume the container's `intent` binding (no sibling-module
 * imports).
 *
 * Sources gathered (v1 locked decision — no arbitrary URL fetching):
 *  - PR description        → `fetched` when non-empty
 *  - linked issue (#N)     → GitHub adapter (body regex) / GitLab PR host (body
 *                            regex, else the MR's same-project `closes_issues`);
 *                            failure or null ⇒ `unavailable`
 *  - repo docs (specs/docs *.md mentions) → git.readFile; throw ⇒ `unavailable`
 *  - external URLs         → ALWAYS `unavailable` (never fetched, never fabricated)
 *
 * Confidence is deterministic in code (intent-helpers.computeConfidence) —
 * never model-self-reported.
 */

/** Minimal structural logger (pino-compatible `(obj, msg)`) — no framework types inward. */
export interface IntentLogger {
  info: (obj: unknown, msg?: string) => void;
}

// Structural projections of the rows the deriver consumes — the repository's
// Drizzle row types satisfy these without leaking $inferSelect inward.
export interface IntentPull {
  id: string;
  repoId: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  headSha: string;
  body: string | null;
}

export interface IntentPrFile {
  path: string;
  patch: string | null;
}

export interface IntentRepo {
  owner: string;
  name: string;
  /** Host identity (repos row). Absent ⇒ GitHub on github.com (pre-GitLab rows / fixtures). */
  fullName?: string;
  provider?: RepoProvider | string | null;
  host?: string | null;
}

/** Explicit deps object — built in the composition root, never `Container`. */
export interface IntentDeriverDeps {
  repo: {
    getPull(workspaceId: string, prId: string): Promise<IntentPull | undefined>;
    getRepo(repoId: string): Promise<IntentRepo | undefined>;
    getPrFiles(prId: string): Promise<IntentPrFile[]>;
    upsertIntentDetail(prId: string, input: IntentDetailWrite): Promise<void>;
    getIntentDetail(prId: string): Promise<StoredIntentDetail | undefined>;
  };
  /** GitHub linked-issue path (unchanged): `GitHubClient.getIssue`, throws on failure. */
  github: () => Promise<{ getIssue(repo: RepoRef, n: number): Promise<IssueMeta> }>;
  /**
   * Provider-neutral read-side host (`container.prHost`). Used for non-GitHub
   * repos only: `getIssue` → null when unavailable; `getLinkedIssueNumber` →
   * the same-project issue the MR closes. The GitHub host answers null for
   * both, so GitHub keeps the `github` path above.
   */
  prHost: (provider: RepoProvider) => Promise<Pick<PullRequestHost, 'getIssue' | 'getLinkedIssueNumber'>>;
  git: { readFile(repo: RepoRef, path: string): Promise<string> };
  llm: (id: Provider) => Promise<LLMProvider>;
  resolveModel: (workspaceId: string) => Promise<FeatureModelChoice>;
}

type LinkedIssue =
  | { status: 'fetched'; ref: string; title: string; body: string | null }
  | { status: 'unavailable'; ref: string };

/**
 * Resolve + fetch the PR's linked issue. Returns `undefined` when the PR links
 * no issue, `unavailable` when it links one that could not be fetched (any
 * failure, incl. a confidential/404 GitLab issue — AC-23), else the issue.
 *
 * GitHub: body regex + `GitHubClient.getIssue`, byte-identical to pre-GitLab.
 * GitLab: body regex, else the MR's `closes_issues` relation (same project only).
 * The issue text is returned RAW — reviewer-core's prompt builder wraps it as
 * untrusted; never wrap or strip it here.
 */
async function fetchLinkedIssue(
  deps: IntentDeriverDeps,
  repo: IntentRepo,
  prNumber: number,
  body: string | null,
): Promise<LinkedIssue | undefined> {
  const ref = hostRepoRef({ ...repo, fullName: repo.fullName ?? `${repo.owner}/${repo.name}` });
  if (ref.provider === 'github') {
    const issueNumber = extractIssueRef(body);
    if (issueNumber == null) return undefined;
    try {
      const gh = await deps.github();
      const meta = await gh.getIssue({ owner: repo.owner, name: repo.name }, issueNumber);
      return { status: 'fetched', ref: `#${issueNumber}`, title: meta.title, body: meta.body ?? null };
    } catch {
      return { status: 'unavailable', ref: `#${issueNumber}` };
    }
  }

  let issueNumber = extractIssueRef(body);
  let host: Pick<PullRequestHost, 'getIssue' | 'getLinkedIssueNumber'>;
  try {
    host = await deps.prHost(ref.provider);
    issueNumber ??= (await host.getLinkedIssueNumber(ref, prNumber)) ?? undefined;
  } catch {
    // Host unreachable / relation lookup failed: only a body-declared link is
    // a known (now unavailable) source; otherwise there is nothing to report.
    return issueNumber == null ? undefined : { status: 'unavailable', ref: `#${issueNumber}` };
  }
  if (issueNumber == null) return undefined;
  const issueRef = `#${issueNumber}`;
  try {
    const meta = await host.getIssue(ref, issueNumber);
    return meta
      ? { status: 'fetched', ref: issueRef, title: meta.title, body: meta.body ?? null }
      : { status: 'unavailable', ref: issueRef };
  } catch {
    return { status: 'unavailable', ref: issueRef };
  }
}

/**
 * The ref handed to `git.readFile`: GitHub keeps the plain `{owner, name}` it
 * always got; other hosts carry provider/fullName so the adapter resolves the
 * right clone directory.
 */
function gitRepoRef(repo: IntentRepo): RepoRef {
  const ref = hostRepoRef({ ...repo, fullName: repo.fullName ?? `${repo.owner}/${repo.name}` });
  return ref.provider === 'github' ? { owner: repo.owner, name: repo.name } : ref;
}

/** Stored intent for a PR, or null when none has been derived yet. */
export async function getIntent(
  deps: IntentDeriverDeps,
  workspaceId: string,
  prId: string,
): Promise<IntentDetail | null> {
  const pull = await deps.repo.getPull(workspaceId, prId);
  if (!pull) throw new NotFoundError('Pull request not found');
  const stored = await deps.repo.getIntentDetail(prId);
  return stored ? toIntentDetail(stored, pull.headSha) : null;
}

/** Derive (or re-derive) the PR intent synchronously: gather sources → one LLM call → persist. */
export async function deriveIntent(
  deps: IntentDeriverDeps,
  workspaceId: string,
  prId: string,
  logger?: IntentLogger,
): Promise<IntentDetail> {
  const pull = await deps.repo.getPull(workspaceId, prId);
  if (!pull) throw new NotFoundError('Pull request not found');
  const repo = await deps.repo.getRepo(pull.repoId);
  if (!repo) throw new NotFoundError('Repo not found');
  const repoRef = gitRepoRef(repo);

  const body = pull.body;
  const sources: IntentSource[] = [];

  if (body && body.trim().length > 0) {
    sources.push({ kind: 'pr_description', ref: 'PR description', status: 'fetched' });
  }

  // Linked issue via the PR's host; any failure (no token, API error, missing
  // or confidential issue) marks the source unavailable — never fabricated.
  let issue: { ref: string; title?: string | null; body?: string | null } | undefined;
  const linked = await fetchLinkedIssue(deps, repo, pull.number, body);
  if (linked?.status === 'fetched') {
    issue = { ref: linked.ref, title: linked.title, body: linked.body };
    sources.push({ kind: 'linked_issue', ref: linked.ref, title: linked.title, status: 'fetched' });
  } else if (linked) {
    sources.push({ kind: 'linked_issue', ref: linked.ref, status: 'unavailable' });
  }

  // Repo-relative docs via git.readFile on the local clone (no network).
  const docs: { path: string; content: string }[] = [];
  for (const path of extractRepoDocPaths(body)) {
    try {
      const content = await deps.git.readFile(repoRef, path);
      docs.push({ path, content });
      sources.push({ kind: 'repo_doc', ref: path, status: 'fetched' });
    } catch {
      sources.push({ kind: 'repo_doc', ref: path, status: 'unavailable' });
    }
  }

  // v1 locked decision: external URLs are never fetched — honest missing-context marking.
  const externalUrls = extractExternalUrls(body);
  for (const url of externalUrls) {
    sources.push({ kind: 'external_url', ref: url, status: 'unavailable' });
  }

  const prFiles = await deps.repo.getPrFiles(prId);
  const files = prFiles.map((f) => ({
    path: f.path,
    hunkHeaders: hunkHeadersFromPatch(f.patch),
  }));

  const { provider, model } = await deps.resolveModel(workspaceId);
  const llm = await deps.llm(provider);

  const { messages, sections } = buildIntentMessages({
    title: pull.title,
    author: pull.author,
    branch: pull.branch,
    baseBranch: pull.base,
    body,
    files,
    issue,
    docs,
    externalUrls,
  });

  const res = await llm.completeStructured<IntentClassification>({
    model,
    schema: IntentClassification,
    schemaName: 'IntentClassification',
    messages,
  });

  const confidence = computeConfidence(body, sources);

  await deps.repo.upsertIntentDetail(prId, {
    intent: res.data.summary,
    in_scope: res.data.in_scope,
    out_of_scope: res.data.out_of_scope,
    risk_areas: res.data.risk_areas,
    confidence,
    sources,
    model,
    head_sha: pull.headSha,
    tokens_in: res.tokensIn,
    tokens_out: res.tokensOut,
    cost_usd: res.costUsd,
  });

  // ONE structured line per classification — sections/sizes and source
  // statuses only; NEVER source bodies, diff content, or secrets.
  const totalChars = sections.reduce((n, s) => n + s.chars, 0);
  logger?.info(
    {
      feature: 'intent',
      provider,
      model,
      promptSections: sections,
      tokenEstimate: Math.ceil(totalChars / 4),
      sources: sources.map(({ kind, ref, status }) => ({ kind, ref, status })),
    },
    `intent: classified PR #${pull.number} (confidence=${confidence})`,
  );

  const stored = await deps.repo.getIntentDetail(prId);
  if (!stored) throw new NotFoundError('Intent not found after classification');
  return toIntentDetail(stored, pull.headSha);
}

/**
 * Stored intent when its head_sha matches the pull's current head; otherwise
 * derive inline (persisting). Used by the review executor as best-effort
 * shared pre-work.
 */
export async function getOrDeriveIntentFresh(
  deps: IntentDeriverDeps,
  workspaceId: string,
  pull: IntentPull,
  logger?: IntentLogger,
): Promise<IntentDetail> {
  const stored = await deps.repo.getIntentDetail(pull.id);
  if (stored && stored.head_sha === pull.headSha) {
    return toIntentDetail(stored, pull.headSha);
  }
  return deriveIntent(deps, workspaceId, pull.id, logger);
}

/** The container-facing binding of the free functions over one deps object. */
export interface IntentDeriver {
  get(workspaceId: string, prId: string): Promise<IntentDetail | null>;
  derive(workspaceId: string, prId: string, logger?: IntentLogger): Promise<IntentDetail>;
  getOrDeriveFresh(
    workspaceId: string,
    pull: IntentPull,
    logger?: IntentLogger,
  ): Promise<IntentDetail>;
}

/** Bind the free functions to an explicit deps object (called by the composition root). */
export function createIntentDeriver(deps: IntentDeriverDeps): IntentDeriver {
  return {
    get: (workspaceId, prId) => getIntent(deps, workspaceId, prId),
    derive: (workspaceId, prId, logger) => deriveIntent(deps, workspaceId, prId, logger),
    getOrDeriveFresh: (workspaceId, pull, logger) =>
      getOrDeriveIntentFresh(deps, workspaceId, pull, logger),
  };
}
