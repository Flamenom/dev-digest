import { simpleGit, type SimpleGit } from 'simple-git';
import { dirname, join, resolve, sep } from 'node:path';
import { mkdir, readFile, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import type {
  HostGitClient,
  CloneOptions,
  UnifiedDiff,
  BlameLine,
  GitCommit,
  GitCredential,
  GitCredentialResolver,
  HostRepoRef,
  FetchPullHeadOptions,
} from '@devdigest/shared';
import { PROVIDER_HOST, cloneRemoteUrl } from '@devdigest/shared';
import { parseUnifiedDiff } from './diff-parser.js';
import { redactSecret } from '../../platform/redact.js';

/**
 * Depth fetched by `sync()`. Deeper than the shallow clone (CLONE_DEPTH=1) so the
 * previously-indexed sha is usually reachable, keeping the resync diff incremental;
 * when it isn't, the indexer falls back to a full reindex.
 */
const RESYNC_FETCH_DEPTH = 50;

/** Depth for the GitLab MR-ref fetch (AC-30). */
const MR_FETCH_DEPTH = 50;

/** Namespace dir for GitLab clones — `@` can never be a GitHub owner (Q9). */
const GITLAB_CLONE_NAMESPACE = '@gitlab.com';

/** git >= 2.31 honours GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n. */
const MIN_ENV_CONFIG_VERSION = { major: 2, minor: 31 } as const;

/**
 * Env keys simple-git's unsafe-operations plugin rejects when an explicit env is
 * passed via `.env()` (lower-cased). `git_config_count` is re-added by us — with
 * `allowUnsafeConfigEnvCount` — only for the credential header.
 */
const SIMPLE_GIT_BLOCKED_ENV = new Set([
  'editor',
  'git_askpass',
  'git_config_global',
  'git_config_system',
  'git_config_count',
  'git_config',
  'git_editor',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'git_proxy_command',
  'git_template_dir',
  'git_sequence_editor',
  'git_ssh',
  'git_ssh_command',
  'pager',
  'prefix',
  'ssh_askpass',
]);

/**
 * Keys never forwarded to a network git child: the ones simple-git refuses, the
 * tracing switches that would print the Authorization header, and any inherited
 * env-config entries (ours replace them).
 */
function isStrippedEnvKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    SIMPLE_GIT_BLOCKED_ENV.has(k) ||
    k.startsWith('git_trace') || // GIT_TRACE, GIT_TRACE_CURL, GIT_TRACE_PACKET, …
    k === 'git_curl_verbose' ||
    k === 'git_config_parameters' ||
    /^git_config_(key|value)_\d+$/.test(k)
  );
}

/** `scheme://userinfo@…` */
const URL_USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i;

export type GitEnv = Record<string, string>;

/**
 * Test seam: builds the simple-git instance for one invocation. `env` is passed
 * only for network ops (clone/fetch) and is the COMPLETE child env.
 */
export type GitFactory = (baseDir: string, env?: GitEnv) => SimpleGit;

export const createSimpleGit: GitFactory = (baseDir, env) => {
  if (!env) return simpleGit(baseDir);
  // The GIT_CONFIG_* triple is ours (credential header); allow it explicitly.
  return simpleGit({ baseDir, unsafe: { allowUnsafeConfigEnvCount: true } }).env(env);
};

export interface SimpleGitClientOptions {
  /** Per-invocation credential lookup (never cached — a rotated token applies at once). */
  credentials?: GitCredentialResolver;
  gitFactory?: GitFactory;
}

interface NetworkAuth {
  env: GitEnv;
  /** Secret strings to redact from any surfaced git error. */
  secrets: string[];
  /** A credential existed but git is too old to receive it via env config. */
  headerSuppressed: boolean;
}

/**
 * Canonicalise a host ref: only `gitlab` is GitLab (anything else ⇒ github),
 * the host is derived from the provider, and a missing `fullName` (legacy
 * callers / fixtures) falls back to `owner/name`.
 */
function toHostRef(repo: HostRepoRef): HostRepoRef {
  const provider = repo.provider === 'gitlab' ? 'gitlab' : 'github';
  return {
    owner: repo.owner,
    name: repo.name,
    provider,
    host: PROVIDER_HOST[provider],
    fullName: repo.fullName || `${repo.owner}/${repo.name}`,
  };
}

function assertSafeSegments(parts: string[]): void {
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0')) {
      throw new Error(`Unsafe repository path segment: ${JSON.stringify(p)}`);
    }
  }
}

/** Basic auth value for the http.extraHeader (Q8). */
function basicValue(cred: GitCredential): string {
  return Buffer.from(`${cred.username}:${cred.token}`, 'utf8').toString('base64');
}

/**
 * HostGitClient over simple-git. GitHub repos clone to `<cloneDir>/<owner>/<repo>`,
 * GitLab ones to `<cloneDir>/@gitlab.com/<ns…>/<project>`. We NEVER execute repo
 * code — only git ops.
 *
 * Credentials (Q8): supplied per network invocation as a host-scoped
 * `http.https://<host>/.extraHeader` through GIT_CONFIG_* env — never in argv,
 * the remote URL or `.git/config`.
 */
export class SimpleGitClient implements HostGitClient {
  private readonly credentials?: GitCredentialResolver;
  private readonly gitFactory: GitFactory;
  private envConfigSupported?: Promise<boolean>;

  constructor(
    private cloneDir: string,
    opts: SimpleGitClientOptions = {},
  ) {
    this.credentials = opts.credentials;
    this.gitFactory = opts.gitFactory ?? createSimpleGit;
    // Force non-interactive auth so an unauthenticated/private clone fails in
    // ~1s with a clear error instead of hanging on a credential prompt until the
    // job timeout. Set on process.env (inherited by git subprocesses) rather
    // than via simple-git's .env(), which inspects and rejects vars like
    // PAGER/EDITOR present in the shell environment. Network ops pass an
    // explicit, filtered env built from process.env (see `networkAuth`).
    process.env.GIT_TERMINAL_PROMPT ??= '0';
    process.env.GCM_INTERACTIVE ??= 'never';
  }

  clonePathFor(repo: HostRepoRef): string {
    const ref = toHostRef(repo);
    const segments =
      ref.provider === 'gitlab'
        ? [GITLAB_CLONE_NAMESPACE, ...ref.owner.split('/'), ref.name]
        : [ref.owner, ref.name];
    if (ref.provider === 'gitlab') assertSafeSegments(segments.slice(1));
    const path = join(this.cloneDir, ...segments);
    const root = resolve(this.cloneDir) + sep;
    if (!resolve(path).startsWith(root)) {
      throw new Error(`Clone path escapes the clone root for ${JSON.stringify(ref.fullName)}`);
    }
    return path;
  }

  private git(repo: HostRepoRef): SimpleGit {
    return this.gitFactory(this.clonePathFor(repo));
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Checked once per client; `false` ⇒ never send a header (fail closed, no URL fallback). */
  private supportsEnvConfig(): Promise<boolean> {
    this.envConfigSupported ??= (async () => {
      try {
        const v = await this.gitFactory(process.cwd()).version();
        return (
          v.major > MIN_ENV_CONFIG_VERSION.major ||
          (v.major === MIN_ENV_CONFIG_VERSION.major && v.minor >= MIN_ENV_CONFIG_VERSION.minor)
        );
      } catch {
        return false;
      }
    })();
    return this.envConfigSupported;
  }

  /** Builds the child env (and redaction secrets) for ONE network invocation. */
  private async networkAuth(ref: HostRepoRef): Promise<NetworkAuth> {
    const env: GitEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !isStrippedEnvKey(k)) env[k] = v;
    }
    env.GIT_TERMINAL_PROMPT ??= '0';
    env.GCM_INTERACTIVE ??= 'never';

    const cred = this.credentials ? await this.credentials(ref) : null;
    if (!cred || !cred.token) return { env, secrets: [], headerSuppressed: false };

    const b64 = basicValue(cred);
    const secrets = [cred.token, b64];
    if (!(await this.supportsEnvConfig())) {
      return { env, secrets, headerSuppressed: true };
    }
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.https://${PROVIDER_HOST[ref.provider]}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${b64}`;
    return { env, secrets, headerSuppressed: false };
  }

  /** Runs a git op, surfacing only a redacted error (token, base64 header, userinfo). */
  private async guard<T>(auth: NetworkAuth | null, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      let msg = redactSecret(raw, ...(auth?.secrets ?? []));
      if (auth?.headerSuppressed) {
        msg += ` (credentials not sent: git >= ${MIN_ENV_CONFIG_VERSION.major}.${MIN_ENV_CONFIG_VERSION.minor} is required)`;
      }
      const err = new Error(msg);
      err.name = e instanceof Error ? e.name : 'GitError';
      throw err;
    }
  }

  /**
   * Legacy clones may carry a token in `origin` (pre-Q8 GitHub URL embedding).
   * Rewrite it in place to the tokenless canonical URL before any fetch (AC-47).
   */
  private async ensureTokenlessOrigin(ref: HostRepoRef, dir: string): Promise<void> {
    const local = this.gitFactory(dir);
    let url = '';
    try {
      url = (await local.raw(['config', '--get', 'remote.origin.url'])).trim();
    } catch {
      return; // no origin configured — nothing to rewrite
    }
    if (!URL_USERINFO_RE.test(url)) return;
    let clean: string;
    try {
      clean = cloneRemoteUrl(ref.provider, ref.fullName);
    } catch {
      clean = url.replace(/(\/\/)[^\s/@]+@/, '$1');
    }
    await local.remote(['set-url', 'origin', clean]);
  }

  async clone(repo: HostRepoRef, url: string, opts?: CloneOptions): Promise<{ path: string }> {
    const ref = toHostRef(repo);
    if (URL_USERINFO_RE.test(url)) {
      throw new Error(
        `Refusing to clone ${redactSecret(url)}: remote URLs must not carry credentials`,
      );
    }
    const dest = this.clonePathFor(repo);
    await mkdir(dirname(dest), { recursive: true });
    if (await this.exists(join(dest, '.git'))) {
      // already cloned → fetch latest
      await this.guard(null, () => this.ensureTokenlessOrigin(ref, dest));
      const auth = await this.networkAuth(ref);
      await this.guard(auth, () => this.gitFactory(dest, auth.env).fetch());
      return { path: dest };
    }
    // A prior clone may have timed out mid-write, leaving a partial dir without
    // a .git — git clone refuses a non-empty dest, so clear it first.
    if (await this.exists(dest)) await rm(dest, { recursive: true, force: true });
    const args: string[] = [];
    if (opts?.depth) args.push('--depth', String(opts.depth));
    if (opts?.branch) args.push('--branch', opts.branch);
    const auth = await this.networkAuth(ref);
    await this.guard(auth, () => this.gitFactory(this.cloneDir, auth.env).clone(url, dest, args));
    return { path: dest };
  }

  /**
   * Fetch the PR/MR head into a local ref. GitHub exposes `pull/<n>/head`; GitLab
   * exposes `refs/merge-requests/<iid>/head` in the TARGET project, so fork MRs
   * work without access to the fork (AC-30). `opts.base` (GitLab) also fetches the
   * target branch at the same bounded depth so a merge-base is reachable locally.
   */
  async fetchPullHead(repo: HostRepoRef, n: number, opts?: FetchPullHeadOptions): Promise<void> {
    const ref = toHostRef(repo);
    const dir = this.clonePathFor(repo);
    await this.guard(null, () => this.ensureTokenlessOrigin(ref, dir));
    if (ref.provider === 'gitlab') {
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid merge request iid: ${n}`);
      const mrAuth = await this.networkAuth(ref);
      await this.guard(mrAuth, () =>
        this.gitFactory(dir, mrAuth.env).fetch([
          'origin',
          `+refs/merge-requests/${n}/head:refs/devdigest/mr-${n}`,
          '--depth',
          String(MR_FETCH_DEPTH),
        ]),
      );
      const base = opts?.base;
      if (base) {
        const baseAuth = await this.networkAuth(ref);
        await this.guard(baseAuth, () =>
          this.gitFactory(dir, baseAuth.env).fetch([
            'origin',
            base,
            '--depth',
            String(MR_FETCH_DEPTH),
          ]),
        );
      }
      return;
    }
    const auth = await this.networkAuth(ref);
    await this.guard(auth, () =>
      this.gitFactory(dir, auth.env).fetch(['origin', `pull/${n}/head:pr-${n}`]),
    );
  }

  async sync(repo: HostRepoRef, branch: string): Promise<{ head: string }> {
    // Resync the read-only mirror to upstream. A bare `fetch` only moves
    // `origin/<branch>`, so we `reset --hard` to advance local HEAD + worktree —
    // safe here because we never commit to or run code from the clone.
    // Fetch a bounded depth (> the shallow CLONE_DEPTH) so the prior indexed sha
    // is usually reachable for an incremental diff; the indexer falls back to a
    // full reindex when it isn't.
    const ref = toHostRef(repo);
    const dir = this.clonePathFor(repo);
    await this.guard(null, () => this.ensureTokenlessOrigin(ref, dir));
    const auth = await this.networkAuth(ref);
    await this.guard(auth, () =>
      this.gitFactory(dir, auth.env).fetch([
        'origin',
        branch,
        '--depth',
        String(RESYNC_FETCH_DEPTH),
      ]),
    );
    const g = this.git(repo);
    return this.guard(null, async () => {
      await g.reset(['--hard', `origin/${branch}`]);
      return { head: (await g.revparse(['HEAD'])).trim() };
    });
  }

  async currentHead(repo: HostRepoRef): Promise<string> {
    return (await this.git(repo).revparse(['HEAD'])).trim();
  }

  async diff(repo: HostRepoRef, base: string, head: string): Promise<UnifiedDiff> {
    const raw = await this.git(repo).diff([`${base}...${head}`]);
    return parseUnifiedDiff(raw);
  }

  /**
   * `git diff --name-only base..head` — used by the incremental indexer to
   * pick the file set that changed since `last_indexed_sha`. Two-dot is
   * intentional (commits reachable from `head` but not `base`), unlike the
   * three-dot symmetric form `diff()` uses for review diffs.
   */
  async diffNameOnly(repo: HostRepoRef, base: string, head: string): Promise<string[]> {
    if (base === head) return [];
    const raw = await this.git(repo).raw(['diff', '--name-only', `${base}..${head}`]);
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async blame(repo: HostRepoRef, path: string): Promise<BlameLine[]> {
    const raw = await this.git(repo).raw(['blame', '--line-porcelain', path]);
    return parseBlamePorcelain(raw);
  }

  async log(repo: HostRepoRef, path?: string): Promise<GitCommit[]> {
    const log = await this.git(repo).log(path ? { file: path } : undefined);
    return log.all.map((c) => ({
      sha: c.hash,
      message: c.message,
      author: c.author_name,
      date: c.date,
    }));
  }

  async readFile(repo: HostRepoRef, path: string): Promise<string> {
    return readFile(join(this.clonePathFor(repo), path), 'utf8');
  }
}

function parseBlamePorcelain(raw: string): BlameLine[] {
  const out: BlameLine[] = [];
  const lines = raw.split('\n');
  let sha = '';
  let author = '';
  let date = '';
  let summary = '';
  let lineNo = 0;
  for (const line of lines) {
    const header = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
    if (header) {
      sha = header[1]!;
      lineNo = Number(header[2]);
    } else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('author-time '))
      date = new Date(Number(line.slice(12)) * 1000).toISOString();
    else if (line.startsWith('summary ')) summary = line.slice(8);
    else if (line.startsWith('\t')) {
      out.push({ line: lineNo, sha, author, date, summary });
    }
  }
  return out;
}
