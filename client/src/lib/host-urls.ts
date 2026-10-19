/* host-urls.ts — provider-aware deep links (GitHub + GitLab) built ONLY from the
   repo DTO the server returns (`provider`, `host`, `web_url`, `full_name`), so the
   client never assumes a host (AC-36).

   - GitHub delegates to the unchanged `github-urls.ts` → byte-identical links (AC-38).
   - GitLab: `<web_url>/-/merge_requests/<iid>`, `<web_url>/-/blob/<sha>/<path>`,
     `#L<a>` / `#L<a>-<b>` (AC-37).
   - Safety: a link is returned only when it is `https:` AND its host equals
     `repo.host` exactly (no userinfo, no port, no query/fragment smuggled in via
     `web_url`). Anything else → `null`, so callers render no link rather than a
     `javascript:` or foreign-host href. */

import type { RepoWithHost } from "./types";
import { githubBlobUrl, githubPrUrl } from "./github-urls";

/** The repo fields a host link needs — any `RepoWithHost` satisfies it. */
export type HostLinkRepo = Pick<RepoWithHost, "provider" | "host" | "web_url" | "full_name">;

/**
 * Provider token for i18n labels — use as an ICU `select` argument, e.g.
 * `t("prHost.viewOn", { provider: hostLabelKey(repo) })` with
 * `"View on {provider, select, gitlab {GitLab} other {GitHub}}"`.
 * A missing repo (still loading / unknown) → "github".
 * Brand names stay in the catalogs, not in components.
 */
export type HostLabelKey = RepoWithHost["provider"];

export function hostLabelKey(repo: Pick<RepoWithHost, "provider"> | null | undefined): HostLabelKey {
  return repo?.provider === "gitlab" ? "gitlab" : "github";
}

/**
 * The host accepts no posted comments — GitLab in the MVP (server answers
 * `provider_read_only`). An unknown/unloaded repo is NOT read-only.
 */
export function isReadOnlyHost(repo: Pick<RepoWithHost, "provider"> | null | undefined): boolean {
  return repo?.provider === "gitlab";
}

/** Encode a repo-relative path (or ref) for a URL while keeping "/" separators. */
function encPath(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

/** Accept `url` only if it is https on exactly `repo.host`; returns it unchanged or null. */
function onRepoHost(url: string, repo: Pick<RepoWithHost, "host">): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // `URL.host` includes a port when present, so `gitlab.com:8443` ≠ `gitlab.com`.
  if (parsed.host !== repo.host) return null;
  if (parsed.username || parsed.password) return null;
  return url;
}

/** Validated GitLab project base (`https://gitlab.com/<ns…>/<name>`, no trailing slash). */
function gitlabBase(repo: HostLinkRepo): string | null {
  const raw = repo.web_url?.trim();
  if (!raw) return null;
  const base = onRepoHost(raw, repo);
  if (!base) return null;
  const parsed = new URL(base);
  // web_url is a project root: a query or fragment would corrupt every link built on it.
  if (parsed.search || parsed.hash) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return null;
  return `${parsed.origin}${path}`;
}

function lineAnchor(startLine?: number, endLine?: number): string {
  if (startLine == null) return "";
  if (endLine != null && endLine !== startLine) return `#L${startLine}-${endLine}`;
  return `#L${startLine}`;
}

/** Link to PR/MR `number` on the repo's host, or null when no safe link can be built. */
export function hostPrUrl(repo: HostLinkRepo, number: number): string | null {
  if (repo.provider === "gitlab") {
    const base = gitlabBase(repo);
    return base ? `${base}/-/merge_requests/${number}` : null;
  }
  return onRepoHost(githubPrUrl(repo.full_name, number), repo);
}

/**
 * Link to `file` at `sha` (a commit sha or ref) on the repo's host, optionally
 * anchored to a line or range. Null when no safe link can be built.
 */
export function hostBlobUrl(
  repo: HostLinkRepo,
  sha: string,
  file: string,
  startLine?: number,
  endLine?: number,
): string | null {
  if (repo.provider === "gitlab") {
    const base = gitlabBase(repo);
    if (!base) return null;
    return `${base}/-/blob/${encPath(sha)}/${encPath(file)}${lineAnchor(startLine, endLine)}`;
  }
  return onRepoHost(githubBlobUrl(repo.full_name, sha, file, startLine, endLine), repo);
}
