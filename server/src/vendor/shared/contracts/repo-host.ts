import { z } from 'zod';
import {
  ConnTestProvider,
  ConnTestRequest,
  ConnTestResult,
  IssueMeta,
  PrDetail,
  PrFile,
  PrMeta,
  Repo,
  SecretsStatus,
} from './platform.js';

/**
 * Repository hosts: GitHub + GitLab (spec `specs/2026-10-16-gitlab-merge-requests.md`).
 *
 * ADDITIVE contract — no pre-existing contract file is edited. Every schema here
 * EXTENDS an existing one (`Repo`, `PrMeta`, `PrFile`, `PrDetail`, `IssueMeta`,
 * `ConnTest*`, `SecretsStatus`), so an old-shape object still parses with the
 * old schema and a migrated GitHub object parses with the new one. New optional
 * fields use `.optional()` / `.nullish()` (never a bare `.nullable()`), so no
 * existing fixture has to grow a key.
 */

// ---- Provider identity ----
export const RepoProvider = z.enum(['github', 'gitlab']);
export type RepoProvider = z.infer<typeof RepoProvider>;

/** The only hosts supported in the MVP (gitlab.com only — no self-managed). */
export const RepoHost = z.enum(['github.com', 'gitlab.com']);
export type RepoHost = z.infer<typeof RepoHost>;

/** `running` is in-memory only (never persisted); `failed` = last attempt errored. */
export const RepoSyncState = z.enum(['idle', 'running', 'failed']);
export type RepoSyncState = z.infer<typeof RepoSyncState>;

// ---- Repo DTO (response) ----
/**
 * For GitLab: `owner` = full namespace path (may contain `/`), `name` = project
 * path segment, `full_name` = full project path. `web_url` is derived
 * server-side so the client never assumes a host.
 */
export const RepoWithHost = Repo.extend({
  provider: RepoProvider,
  host: RepoHost,
  web_url: z.string(),
  /** Last SUCCESSFUL PR-list sync. */
  last_synced_at: z.string().nullish(),
  last_attempt_at: z.string().nullish(),
  sync_state: RepoSyncState,
  /** Human-readable, secret-free. */
  last_sync_error: z.string().nullish(),
});
export type RepoWithHost = z.infer<typeof RepoWithHost>;

// ---- PR / MR data ----
export const PrMetaHost = PrMeta.extend({
  /** GitLab MR `draft` flag; absent for GitHub. */
  is_draft: z.boolean().optional(),
  /** false ⇒ additions/deletions/files_count are unknown (client shows "—"). */
  stats_known: z.boolean().optional(),
});
export type PrMetaHost = z.infer<typeof PrMetaHost>;

export const PrFileChangeType = z.enum(['added', 'modified', 'deleted', 'renamed']);
export type PrFileChangeType = z.infer<typeof PrFileChangeType>;

export const PrPatchOmitted = z.enum(['too_large', 'collapsed']);
export type PrPatchOmitted = z.infer<typeof PrPatchOmitted>;

export const PrFileHost = PrFile.extend({
  previous_path: z.string().nullish(),
  change_type: PrFileChangeType.optional(),
  /** Set when the host withheld the patch (then `patch` is null). */
  patch_omitted: PrPatchOmitted.nullish(),
});
export type PrFileHost = z.infer<typeof PrFileHost>;

export const IssueMetaHost = IssueMeta.extend({
  labels: z.array(z.string()).optional(),
});
export type IssueMetaHost = z.infer<typeof IssueMetaHost>;

export const PrDetailHost = PrDetail.extend({
  is_draft: z.boolean().optional(),
  stats_known: z.boolean().optional(),
  files: z.array(PrFileHost),
  /** Count of files whose patch the host withheld (`patch_omitted`). */
  files_omitted_by_host: z.number().int().nonnegative().optional(),
});
export type PrDetailHost = z.infer<typeof PrDetailHost>;

// ---- PR-list sync ----
/** `fresh` = within TTL or failure back-off, no provider call was made. */
export const PrSyncTrigger = z.enum(['fresh', 'started', 'joined']);
export type PrSyncTrigger = z.infer<typeof PrSyncTrigger>;

export const PrListSync = z.object({
  trigger: PrSyncTrigger,
  state: RepoSyncState,
  last_synced_at: z.string().nullish(),
  last_attempt_at: z.string().nullish(),
  last_sync_error: z.string().nullish(),
});
export type PrListSync = z.infer<typeof PrListSync>;

/** `GET /repos/:id/pulls/page`. */
export const PrListPage = z.object({
  pulls: z.array(PrMetaHost),
  sync: PrListSync,
});
export type PrListPage = z.infer<typeof PrListPage>;

/** `POST /repos/:id/pulls/sync` (no request body). */
export const PrSyncStartResult = z.object({
  trigger: z.enum(['started', 'joined']),
});
export type PrSyncStartResult = z.infer<typeof PrSyncStartResult>;

/** The single `done` event of `GET /repos/:id/pulls/sync/events`. */
export const PrSyncDoneEvent = z.object({
  state: RepoSyncState,
  last_synced_at: z.string().nullish(),
  last_sync_error: z.string().nullish(),
});
export type PrSyncDoneEvent = z.infer<typeof PrSyncDoneEvent>;

// ---- Connection test / secrets status ----
export const ConnTestProviderHost = z.enum([...ConnTestProvider.options, 'gitlab']);
export type ConnTestProviderHost = z.infer<typeof ConnTestProviderHost>;

export const ConnTestRequestHost = ConnTestRequest.extend({
  provider: ConnTestProviderHost,
});
export type ConnTestRequestHost = z.infer<typeof ConnTestRequestHost>;

export const ConnTestResultHost = ConnTestResult.extend({
  provider: ConnTestProviderHost,
});
export type ConnTestResultHost = z.infer<typeof ConnTestResultHost>;

export const SecretsStatusHost = SecretsStatus.extend({
  gitlab: z.boolean(),
});
export type SecretsStatusHost = z.infer<typeof SecretsStatusHost>;

// ---- Error codes (stable strings in the existing ApiErrorBody envelope) ----
export const HostErrorCode = z.enum([
  'gitlab_token_missing',
  'gitlab_token_invalid',
  'gitlab_project_inaccessible',
  'unsupported_repo_host',
  'provider_read_only',
]);
export type HostErrorCode = z.infer<typeof HostErrorCode>;
