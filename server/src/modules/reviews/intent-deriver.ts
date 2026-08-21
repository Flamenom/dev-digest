import type {
  FeatureModelChoice,
  IntentDetail,
  IntentDetailWrite,
  IntentSource,
  IssueMeta,
  LLMProvider,
  Provider,
  RepoRef,
  StoredIntentDetail,
} from '@devdigest/shared';
import { IntentClassification } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
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
 *  - linked issue (#N)     → GitHub adapter; failure ⇒ `unavailable`
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
  github: () => Promise<{ getIssue(repo: RepoRef, n: number): Promise<IssueMeta> }>;
  git: { readFile(repo: RepoRef, path: string): Promise<string> };
  llm: (id: Provider) => Promise<LLMProvider>;
  resolveModel: (workspaceId: string) => Promise<FeatureModelChoice>;
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
  const repoRef: RepoRef = { owner: repo.owner, name: repo.name };

  const body = pull.body;
  const sources: IntentSource[] = [];

  if (body && body.trim().length > 0) {
    sources.push({ kind: 'pr_description', ref: 'PR description', status: 'fetched' });
  }

  // Linked issue via the existing GitHub adapter; any failure (no token,
  // API error, missing issue) marks the source unavailable — never fabricated.
  let issue: { ref: string; title?: string | null; body?: string | null } | undefined;
  const issueNumber = extractIssueRef(body);
  if (issueNumber != null) {
    const ref = `#${issueNumber}`;
    try {
      const gh = await deps.github();
      const meta = await gh.getIssue(repoRef, issueNumber);
      issue = { ref, title: meta.title, body: meta.body ?? null };
      sources.push({ kind: 'linked_issue', ref, title: meta.title, status: 'fetched' });
    } catch {
      sources.push({ kind: 'linked_issue', ref, status: 'unavailable' });
    }
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
