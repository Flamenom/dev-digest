/**
 * Repo-host contracts (GitLab spec, plan T1): the new extension schemas accept
 * migrated GitHub objects, the frozen originals keep accepting the old shapes,
 * and the extended enums don't leak back into the frozen ones.
 */
import { describe, it, expect } from 'vitest';
import {
  ConnTestRequest,
  ConnTestRequestHost,
  ConnTestResultHost,
  HostErrorCode,
  PrDetail,
  PrDetailHost,
  PrFileHost,
  PrListPage,
  PrMeta,
  PrMetaHost,
  PrSyncStartResult,
  Repo,
  RepoWithHost,
  SecretsStatus,
  SecretsStatusHost,
} from '@devdigest/shared';

const oldRepo = {
  id: 'r1',
  workspace_id: 'ws1',
  owner: 'acme',
  name: 'web',
  full_name: 'acme/web',
  default_branch: 'main',
  clone_path: '/clones/acme/web',
  last_polled_at: null,
  created_by: null,
};

const prMetaFixture = {
  id: 'pr-uuid',
  number: 482,
  title: 'Add retry to webhook handler',
  author: 'octocat',
  branch: 'feat/retry',
  base: 'main',
  head_sha: 'abc123',
  additions: 10,
  deletions: 2,
  files_count: 3,
  status: 'open' as const,
  opened_at: '2026-10-01T00:00:00Z',
  updated_at: null,
  score: null,
  cost_usd: null,
  findings: null,
};

describe('repo-host contracts', () => {
  it('RepoWithHost accepts a migrated GitHub DTO; Repo still accepts the old shape', () => {
    expect(Repo.parse(oldRepo)).toEqual(oldRepo);

    const migrated = {
      ...oldRepo,
      provider: 'github',
      host: 'github.com',
      web_url: 'https://github.com/acme/web',
      sync_state: 'idle',
    };
    expect(RepoWithHost.parse(migrated)).toMatchObject(migrated);
    // A legacy DTO without provider/host is NOT a RepoWithHost.
    expect(RepoWithHost.safeParse(oldRepo).success).toBe(false);
    // GitLab nested namespace in owner.
    expect(
      RepoWithHost.safeParse({
        ...migrated,
        provider: 'gitlab',
        host: 'gitlab.com',
        owner: 'space-profit/platform',
        name: 'crm-frontend',
        full_name: 'space-profit/platform/crm-frontend',
        web_url: 'https://gitlab.com/space-profit/platform/crm-frontend',
        last_synced_at: null,
        last_sync_error: 'boom',
        sync_state: 'failed',
      }).success,
    ).toBe(true);
    expect(RepoWithHost.safeParse({ ...migrated, provider: 'bitbucket' }).success).toBe(false);
  });

  it('PrMetaHost parses an existing PrMeta fixture unchanged', () => {
    expect(PrMeta.parse(prMetaFixture)).toEqual(prMetaFixture);
    expect(PrMetaHost.parse(prMetaFixture)).toEqual(prMetaFixture);
    expect(PrMetaHost.parse({ ...prMetaFixture, is_draft: true, stats_known: false })).toMatchObject({
      is_draft: true,
      stats_known: false,
    });
  });

  it('PrDetailHost accepts an existing PrDetail and host file extensions', () => {
    const detail = { ...prMetaFixture, body: null, files: [{ path: 'a.ts', additions: 1, deletions: 0 }], commits: [] };
    expect(PrDetail.parse(detail)).toEqual(detail);
    expect(PrDetailHost.parse(detail)).toEqual(detail);

    const file = {
      path: 'b.ts',
      additions: 0,
      deletions: 0,
      patch: null,
      previous_path: 'a.ts',
      change_type: 'renamed',
      patch_omitted: 'too_large',
    };
    expect(PrFileHost.parse(file)).toEqual(file);
    expect(PrFileHost.safeParse({ ...file, patch_omitted: 'huge' }).success).toBe(false);
    expect(PrDetailHost.parse({ ...detail, files: [file], files_omitted_by_host: 1 }).files_omitted_by_host).toBe(1);
  });

  it('ConnTestRequestHost accepts gitlab; the frozen ConnTestRequest rejects it', () => {
    expect(ConnTestRequestHost.parse({ provider: 'gitlab' })).toEqual({ provider: 'gitlab' });
    expect(ConnTestRequestHost.parse({ provider: 'github', key: 'k' })).toEqual({ provider: 'github', key: 'k' });
    expect(ConnTestRequest.safeParse({ provider: 'gitlab' }).success).toBe(false);
    expect(ConnTestResultHost.parse({ provider: 'gitlab', ok: true, message: 'Connected as @me' }).ok).toBe(true);
  });

  it('SecretsStatusHost adds gitlab without changing SecretsStatus', () => {
    const base = { openai: true, anthropic: false, openrouter: false, github: true };
    expect(SecretsStatus.parse(base)).toEqual(base);
    expect(SecretsStatusHost.safeParse(base).success).toBe(false);
    expect(SecretsStatusHost.parse({ ...base, gitlab: false })).toEqual({ ...base, gitlab: false });
  });

  it('PR-list sync shapes and error codes', () => {
    expect(
      PrListPage.parse({
        pulls: [prMetaFixture],
        sync: { trigger: 'fresh', state: 'idle', last_synced_at: null, last_attempt_at: null },
      }).sync.trigger,
    ).toBe('fresh');
    expect(PrSyncStartResult.safeParse({ trigger: 'fresh' }).success).toBe(false);
    expect(HostErrorCode.options).toEqual([
      'gitlab_token_missing',
      'gitlab_token_invalid',
      'gitlab_project_inaccessible',
      'unsupported_repo_host',
      'provider_read_only',
    ]);
  });
});
