/**
 * Project-context discovery — walk the repo clone working tree ONCE and list
 * EVERY markdown document at any depth (`**\/*.md`), skipping only
 * `SKIP_DIRS` (`.git`/`node_modules`/`.claude`). Documents under a bucket
 * directory (`specs`/`docs`/`insights`, see constants.ts) carry that bucket
 * as metadata; all other documents carry `bucket: null`.
 *
 * NFR: discovery reads NO file bodies (p95 ≤ 2 s for ≤5k files). Token
 * estimates come from `fs.stat().size` alone via the same heuristic as the
 * tokenizer adapter's `approxTokens` (tokens ≈ chars / 4, and for the
 * ASCII-dominant markdown these repos hold, chars ≈ bytes) — so the listing
 * figure stays consistent with run-trace figures without opening files.
 * The injected `Tokenizer` is kept in the signature for future precision;
 * a precise count would require reading bodies, which discovery must not do.
 */

import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { DiscoveredDocument, DiscoverySummary } from '@devdigest/shared';
import type { Tokenizer } from '../../adapters/tokenizer/index.js';
import { BUCKETS, type BucketName } from './constants.js';

/** Directories never descended into during the walk. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude']);

/**
 * Byte-length analogue of `approxTokens` (adapters/tokenizer): tokens ≈
 * bytes / 4. Used so discovery can estimate from `stat().size` without
 * reading a single file body.
 */
function approxTokensFromBytes(sizeBytes: number): number {
  return Math.ceil(sizeBytes / 4);
}

/**
 * Bucket assignment (AC-4, deterministic): the OUTERMOST path segment —
 * first from the repo root, filename excluded — that is in `BUCKETS`.
 * `docs/specs/x.md` → `docs`. Returns null when no segment matches
 * (the file is outside every bucket).
 */
function bucketFor(relPath: string): BucketName | null {
  const segments = relPath.split('/');
  // The last segment is the filename; the doc must live UNDER a bucket dir.
  for (let i = 0; i < segments.length - 1; i++) {
    const match = BUCKETS.find((b) => b === segments[i]);
    if (match !== undefined) return match;
  }
  return null;
}

/**
 * Single DFS over the working tree collecting repo-relative `.md` file paths
 * (POSIX-separated). Skips `SKIP_DIRS`; does not follow directory symlinks
 * (a symlinked dir is not `isDirectory()` on a dirent, so loops/escapes are
 * never traversed). Unreadable directories are skipped fail-soft.
 */
async function collectMarkdownPaths(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending: string[] = ['']; // repo-relative directory paths
  while (pending.length > 0) {
    const relDir = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable mid-walk — discovery never throws
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) pending.push(rel);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        found.push(rel);
      }
    }
  }
  return found;
}

function emptyResult(): { documents: DiscoveredDocument[]; summary: DiscoverySummary } {
  return {
    documents: [],
    summary: {
      document_count: 0,
      total_estimated_tokens: 0,
      refreshed_at: new Date().toISOString(),
      clone_available: false,
    },
  };
}

/**
 * Discover the repo clone's project documents. `cloneRoot` null / absent /
 * not a directory → empty result with `clone_available: false` (AC-5), never
 * an error. Results are sorted deterministically by path (codepoint order).
 */
export async function discover(
  cloneRoot: string | null,
  // Kept for future precise counting (injected via the container); the
  // body-free NFR means the byte-size heuristic is used today.
  _tokenizer: Tokenizer,
): Promise<{ documents: DiscoveredDocument[]; summary: DiscoverySummary }> {
  if (cloneRoot === null) return emptyResult();
  try {
    const rootStat = await stat(cloneRoot);
    if (!rootStat.isDirectory()) return emptyResult();
  } catch {
    return emptyResult(); // fs.stat miss ⇒ clone not available (AC-5)
  }

  const markdownPaths = await collectMarkdownPaths(cloneRoot);

  const documents = (
    await Promise.all(
      markdownPaths.map(async (relPath): Promise<DiscoveredDocument | null> => {
        const bucket = bucketFor(relPath); // null = outside every bucket dir; still listed
        let sizeBytes: number;
        try {
          sizeBytes = (await stat(path.join(cloneRoot, relPath))).size;
        } catch {
          return null; // vanished between walk and stat — skip fail-soft
        }
        return { path: relPath, bucket, estimated_tokens: approxTokensFromBytes(sizeBytes) };
      }),
    )
  ).filter((doc): doc is DiscoveredDocument => doc !== null);

  documents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    documents,
    summary: {
      document_count: documents.length,
      total_estimated_tokens: documents.reduce((sum, d) => sum + d.estimated_tokens, 0),
      refreshed_at: new Date().toISOString(),
      clone_available: true,
    },
  };
}
