/**
 * Repo-identity primitives + secret redaction (GitLab plan T1, Q8): refs default
 * to GitHub, remote URLs are always tokenless, and redactSecret masks the raw
 * token, its Basic-auth base64 form, URL userinfo and auth header values.
 */
import { describe, it, expect } from 'vitest';
import { cloneRemoteUrl, hostRepoRef, repoWebUrl } from '../src/modules/_shared/repo-ref.js';
import { redactSecret } from '../src/platform/redact.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('hostRepoRef', () => {
  it('defaults a provider-less row to github/github.com', () => {
    expect(hostRepoRef({ owner: 'acme', name: 'web', fullName: 'acme/web' })).toEqual({
      owner: 'acme',
      name: 'web',
      fullName: 'acme/web',
      provider: 'github',
      host: 'github.com',
    });
    expect(hostRepoRef({ owner: 'acme', name: 'web', fullName: 'acme/web', provider: null, host: null }).provider).toBe(
      'github',
    );
  });

  it('carries a GitLab nested namespace', () => {
    expect(
      hostRepoRef({
        owner: 'space-profit/platform',
        name: 'crm-frontend',
        fullName: 'space-profit/platform/crm-frontend',
        provider: 'gitlab',
        host: 'gitlab.com',
      }),
    ).toEqual({
      owner: 'space-profit/platform',
      name: 'crm-frontend',
      fullName: 'space-profit/platform/crm-frontend',
      provider: 'gitlab',
      host: 'gitlab.com',
    });
  });
});

describe('repoWebUrl / cloneRemoteUrl', () => {
  it('builds canonical https URLs', () => {
    expect(repoWebUrl('github', 'github.com', 'acme/web')).toBe('https://github.com/acme/web');
    expect(repoWebUrl('gitlab', 'gitlab.com', 'a/b/c')).toBe('https://gitlab.com/a/b/c');
    expect(cloneRemoteUrl('github', 'acme/web')).toBe('https://github.com/acme/web.git');
    expect(cloneRemoteUrl('gitlab', 'space-profit/platform/crm-frontend')).toBe(
      'https://gitlab.com/space-profit/platform/crm-frontend.git',
    );
  });

  it('never embeds userinfo and rejects unsafe paths', () => {
    expect(cloneRemoteUrl('gitlab', 'a/b')).not.toContain('@');
    for (const bad of ['acme', 'acme/../etc', 'x:tok@evil/a', 'a//b', 'a/b c', '']) {
      expect(() => cloneRemoteUrl('github', bad)).toThrow();
      expect(() => repoWebUrl('github', 'github.com', bad)).toThrow();
    }
  });
});

describe('redactSecret', () => {
  it('masks a token embedded as URL userinfo', () => {
    const out = redactSecret('fatal: unable to access https://oauth2:glpat-x@gitlab.com/a/b.git', 'glpat-x');
    expect(out).not.toContain('glpat-x');
    expect(out).toContain('gitlab.com/a/b.git');
  });

  it('masks the token and its Basic base64 form in an Authorization header', () => {
    const header = b64('oauth2:glpat-x');
    const out = redactSecret('Authorization: Basic ' + header, 'glpat-x');
    expect(out).not.toContain('glpat-x');
    expect(out).not.toContain(header);
  });

  it('masks the base64 form for the GitHub username even outside a header', () => {
    const header = b64('x-access-token:ghp_SECRET');
    const out = redactSecret(`env GIT_CONFIG_VALUE_0 leaked ${header} and ghp_SECRET`, 'ghp_SECRET');
    expect(out).not.toContain(header);
    expect(out).not.toContain('ghp_SECRET');
  });

  it('masks unknown Bearer / PRIVATE-TOKEN values and userinfo without a known secret', () => {
    const out = redactSecret(
      'authorization: bearer abc.def PRIVATE-TOKEN: zzz https://u:p@host/x',
    );
    expect(out).not.toMatch(/abc\.def|zzz|u:p@/);
  });

  it('ignores empty secrets and leaves clean text alone', () => {
    expect(redactSecret('nothing to see', '', undefined, null)).toBe('nothing to see');
  });
});
