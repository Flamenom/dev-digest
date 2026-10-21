import { describe, it, expect } from 'vitest';
import { AppError } from '../src/platform/errors.js';
import { cloneError } from '../src/modules/repos/service.js';

const TOKEN = 'glpat-0123456789abcdef';
const URL_WITH_TOKEN = `https://oauth2:${TOKEN}@gitlab.com/space-profit/platform/crm-frontend.git/`;

describe('cloneError — GitLab clone failure mapping', () => {
  it('maps an SSH-only group/project (HTTP Git disabled) to gitlab_http_git_disabled, not the token hint', () => {
    const err = cloneError(
      'gitlab',
      new Error(
        `remote: Git access over HTTP is not allowed\nfatal: unable to access '${URL_WITH_TOKEN}': The requested URL returned error: 403`,
      ),
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('gitlab_http_git_disabled');
    expect(err.message).toMatch(/only allows Git over SSH/);
    expect(err.message).toMatch(/Enabled Git access protocols/);
    expect(err.message).not.toMatch(/token/i);
    // The raw cause is kept for diagnosis, redacted.
    const cause = ((err as AppError).details as { cause: string }).cause;
    expect(cause).toContain('Git access over HTTP is not allowed');
    expect(cause).not.toContain(TOKEN);
  });

  it('maps a plain 401/403 auth failure to gitlab_token_missing with the api-scope hint', () => {
    for (const raw of [
      `fatal: Authentication failed for '${URL_WITH_TOKEN}'`,
      `fatal: unable to access '${URL_WITH_TOKEN}': The requested URL returned error: 403`,
      `fatal: unable to access '${URL_WITH_TOKEN}': The requested URL returned error: 401`,
    ]) {
      const err = cloneError('gitlab', new Error(raw));
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('gitlab_token_missing');
      expect(err.message).toMatch(/connect a GitLab token in Settings/);
      expect(err.message).toMatch(/\bapi scope\b/);
      expect(err.message).not.toMatch(/read_repository/);
      expect(JSON.stringify({ m: err.message, d: (err as AppError).details })).not.toContain(TOKEN);
    }
  });

  it('leaves non-auth and GitHub failures as plain redacted errors', () => {
    const gl = cloneError('gitlab', new Error(`fatal: early EOF from ${URL_WITH_TOKEN}`));
    expect(gl).not.toBeInstanceOf(AppError);
    expect(gl.message).not.toContain(TOKEN);

    // The SSH-only text is GitLab-specific; on GitHub it is not re-mapped.
    const gh = cloneError(
      'github',
      new Error(`remote: Git access over HTTP is not allowed\nfatal: unable to access 'https://x-access-token:${TOKEN}@github.com/a/b.git/': 403`),
    );
    expect(gh).not.toBeInstanceOf(AppError);
    expect(gh.message).not.toContain(TOKEN);
  });
});
