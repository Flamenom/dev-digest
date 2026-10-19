import { describe, it, expect } from 'vitest';
import { parseRepoUrl, parseRepoUrlHost } from '../src/modules/repos/helpers.js';

/**
 * Characterization of the GitHub URL rules (Rec-1 / AC-11). Written BEFORE the
 * parser was generalised for gitlab.com: these cases must keep passing with
 * `parseRepoUrl` untouched.
 */

function errorOf(fn: () => unknown): { code?: string; statusCode?: number } {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; statusCode?: number };
  }
  throw new Error('expected the call to throw');
}

const GITHUB_ACCEPTED: [string, string, string][] = [
  ['https://github.com/acme/web', 'acme', 'web'],
  ['https://github.com/acme/web.git', 'acme', 'web'],
  ['https://github.com/acme/web/', 'acme', 'web'],
  ['  https://github.com/acme/web  ', 'acme', 'web'],
  ['https://GitHub.com/Acme/Web', 'Acme', 'Web'],
  ['https://github.com/acme/web?tab=readme#top', 'acme', 'web'],
  ['git@github.com:acme/web.git', 'acme', 'web'],
  ['git@github.com:acme/web', 'acme', 'web'],
  ['https://github.com/my-org.io/repo_name.js', 'my-org.io', 'repo_name.js'],
];

describe('parseRepoUrl — GitHub characterization (AC-11)', () => {
  it.each(GITHUB_ACCEPTED)('accepts %s', (url, owner, name) => {
    expect(parseRepoUrl(url)).toEqual({ owner, name });
  });

  it.each([
    // SSRF: a host that merely mentions github.com in its path.
    'https://internal/github.com/a/b',
    'https://evil.example.com/github.com/a/b',
    'http://github.com/acme/web',
    'file:///etc/github.com/a/b',
    'ftp://github.com/acme/web',
    // Traversal / wrong segment counts.
    'https://github.com/../b',
    'https://github.com/acme/../b',
    'git@github.com:../web.git',
    'git@github.com:acme/..',
    'https://github.com/acme/web/tree',
    'https://github.com/acme',
    'https://github.com/',
    'not a url',
    'acme/web',
    'https://github.com/ac$me/web',
  ])('rejects %s with 400 invalid_repo_url', (url) => {
    const err = errorOf(() => parseRepoUrl(url));
    expect(err.code).toBe('invalid_repo_url');
    expect(err.statusCode).toBe(400);
  });
});

describe('parseRepoUrlHost — GitHub delegates unchanged (AC-11)', () => {
  it.each(GITHUB_ACCEPTED)('accepts %s as github', (url, owner, name) => {
    expect(parseRepoUrlHost(url)).toEqual({
      provider: 'github',
      host: 'github.com',
      owner,
      name,
      fullName: `${owner}/${name}`,
    });
  });

  it.each([
    'https://github.com/acme/../b',
    'git@github.com:../web.git',
    'https://github.com/acme/web/tree',
    'https://github.com/acme',
    'https://github.com/ac$me/web',
    'not a url',
  ])('still rejects %s with 400 invalid_repo_url', (url) => {
    const err = errorOf(() => parseRepoUrlHost(url));
    expect(err.code).toBe('invalid_repo_url');
    expect(err.statusCode).toBe(400);
  });
});

describe('parseRepoUrlHost — gitlab.com', () => {
  const CRM = 'space-profit/platform/crm-frontend';

  it.each([
    `https://gitlab.com/${CRM}`,
    `https://gitlab.com/${CRM}/`,
    `https://gitlab.com/${CRM}.git`,
    `https://gitlab.com/${CRM}/-/tree/main`,
    `https://gitlab.com/${CRM}/-/merge_requests/5`,
    `https://gitlab.com/${CRM}/-/blob/main/src/a.ts`,
    `git@gitlab.com:${CRM}.git`,
    `https://gitlab.com/${CRM}?ref=main`,
    `https://gitlab.com/${CRM}#readme`,
    `https://GitLab.com/${CRM}`,
  ])('normalises %s to the same project path (AC-8)', (url) => {
    expect(parseRepoUrlHost(url)).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      owner: 'space-profit/platform',
      name: 'crm-frontend',
      fullName: CRM,
    });
  });

  it('splits nested namespaces and enforces 2–21 segments (AC-7)', () => {
    expect(parseRepoUrlHost('https://gitlab.com/a/b/c/d/e')).toMatchObject({
      owner: 'a/b/c/d',
      name: 'e',
      fullName: 'a/b/c/d/e',
    });
    const seg = (n: number) => Array.from({ length: n }, (_, i) => `g${i}`).join('/');
    expect(parseRepoUrlHost(`https://gitlab.com/${seg(21)}`).fullName).toBe(seg(21));
    const err = errorOf(() => parseRepoUrlHost(`https://gitlab.com/${seg(22)}`));
    expect(err.statusCode).toBe(400);
    expect(errorOf(() => parseRepoUrlHost('https://gitlab.com/solo')).statusCode).toBe(400);
  });

  it.each([
    'https://gitlab.example.com/a/b',
    'https://www.gitlab.com/a/b',
    'https://gitlab.com./a/b',
    'https://1.2.3.4/a/b',
    'https://[::1]/a/b',
    'https://gitlab.com:8443/a/b',
    'https://user@gitlab.com/a/b',
    'https://user:secret@github.com/a/b',
    'http://gitlab.com/a/b',
    'ssh://git@gitlab.com/a/b.git',
    'git@gitlab.example.com:a/b.git',
    'https://internal/gitlab.com/a/b',
    'https://internal/github.com/a/b',
  ])('rejects %s with 400 unsupported_repo_host (AC-9)', (url) => {
    const err = errorOf(() => parseRepoUrlHost(url));
    expect(err.code).toBe('unsupported_repo_host');
    expect(err.statusCode).toBe(400);
  });

  it.each([
    'https://gitlab.com/a/../b',
    'https://gitlab.com/a/%2e%2e/b',
    'https://gitlab.com/a/%2E%2E/b',
    'https://gitlab.com/a/b/c/..',
    'https://gitlab.com/a/./b',
    'https://gitlab.com/a\\..\\b',
    'https://gitlab.com/a/b;rm',
    'https://gitlab.com/a/b c',
    'https://gitlab.com/a//b',
    'https://gitlab.com/a/-b',
    'https://gitlab.com/a/b.',
    'https://gitlab.com/a/b..c',
    'https://gitlab.com/a/$(id)',
    'git@gitlab.com:a/../b.git',
    'git@gitlab.com:../b.git',
    'gitlab.com/a/../b',
  ])('rejects %s with 400 before any network/filesystem use (AC-10)', (url) => {
    const err = errorOf(() => parseRepoUrlHost(url));
    expect(err.statusCode).toBe(400);
    expect(['invalid_repo_url', 'unsupported_repo_host']).toContain(err.code);
  });
});
