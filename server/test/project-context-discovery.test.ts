import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { discover } from '../src/modules/project-context/discovery.js';
import { BUCKETS } from '../src/modules/project-context/constants.js';
import type { Tokenizer } from '../src/adapters/tokenizer/index.js';

/**
 * Hermetic discovery tests (AC-1..AC-5) over a real temp fixture tree.
 * Discovery is body-free (byte/4 estimate from stat), outermost-bucket-wins,
 * skips .git/node_modules, sorts by path, and degrades to an empty result
 * with clone_available:false when the clone is absent.
 */

const tokenizer: Tokenizer = { count: (text) => Math.ceil(text.length / 4) };

let root: string;

async function put(relPath: string, body: string): Promise<void> {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body, 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pc-discovery-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discover', () => {
  it('includes EVERY .md at any depth, excluding only skip dirs and non-.md (AC-1)', async () => {
    await put('specs/a.md', 'spec a');
    await put('docs/guide/deep/nested.md', 'nested doc');
    await put('insights/i.md', 'insight');
    await put('src/specs/inner.md', 'spec under src'); // bucket dir at depth — included
    await put('README.md', 'root readme'); // repo root — included, bucket null
    await put('notes/x.md', 'not a bucket'); // non-bucket dir — included, bucket null
    await put('docs/image.png', 'binary-ish'); // not .md — excluded
    await put('node_modules/specs/skip.md', 'dep doc'); // skip dir — excluded
    await put('.git/docs/skip.md', 'git internals'); // skip dir — excluded
    await put('.claude/specs/skill.md', 'agent config doc'); // skip dir — excluded

    const { documents, summary } = await discover(root, tokenizer);

    expect(documents.map((d) => d.path)).toEqual([
      'README.md',
      'docs/guide/deep/nested.md',
      'insights/i.md',
      'notes/x.md',
      'specs/a.md',
      'src/specs/inner.md',
    ]);
    expect(documents.find((d) => d.path === 'README.md')?.bucket).toBeNull();
    expect(documents.find((d) => d.path === 'notes/x.md')?.bucket).toBeNull();
    expect(documents.find((d) => d.path === 'specs/a.md')?.bucket).toBe('specs');
    expect(summary.clone_available).toBe(true);
    expect(summary.document_count).toBe(6);
  });

  it('every document carries path + bucket + estimated_tokens (AC-2), estimate = ceil(bytes/4)', async () => {
    const body = 'x'.repeat(10); // 10 bytes → ceil(10/4) = 3 tokens
    await put('specs/a.md', body);

    const { documents, summary } = await discover(root, tokenizer);

    expect(documents).toEqual([{ path: 'specs/a.md', bucket: 'specs', estimated_tokens: 3 }]);
    expect(summary.total_estimated_tokens).toBe(3);
    expect(typeof summary.refreshed_at).toBe('string');
  });

  it('outermost bucket wins: docs/specs/x.md → bucket "docs", stable on repeat (AC-4)', async () => {
    await put('docs/specs/x.md', 'nested bucket dirs');

    const first = await discover(root, tokenizer);
    const second = await discover(root, tokenizer);

    expect(first.documents).toEqual([
      { path: 'docs/specs/x.md', bucket: 'docs', estimated_tokens: expect.any(Number) },
    ]);
    expect(second.documents).toEqual(first.documents); // deterministic on repeat
  });

  it('the bucket metadata set is driven by the BUCKETS constant (AC-3)', async () => {
    // Build one doc per configured bucket — whatever BUCKETS contains.
    for (const bucket of BUCKETS) {
      await put(`${bucket}/doc.md`, `doc in ${bucket}`);
    }
    await put('definitely-not-a-bucket/doc.md', 'outside every bucket');

    const { documents } = await discover(root, tokenizer);

    // Every doc is listed; bucket metadata comes only from BUCKETS (null otherwise).
    expect(documents).toHaveLength(BUCKETS.length + 1);
    expect(new Set(documents.map((d) => d.bucket))).toEqual(new Set([...BUCKETS, null]));
    expect(documents.find((d) => d.path.startsWith('definitely-not-a-bucket/'))?.bucket).toBeNull();
  });

  it('null clone root → empty result with clone_available:false (AC-5)', async () => {
    const { documents, summary } = await discover(null, tokenizer);
    expect(documents).toEqual([]);
    expect(summary).toMatchObject({
      document_count: 0,
      total_estimated_tokens: 0,
      clone_available: false,
    });
  });

  it('missing clone dir → empty result with clone_available:false, never throws (AC-5)', async () => {
    const { documents, summary } = await discover(path.join(root, 'no-such-dir'), tokenizer);
    expect(documents).toEqual([]);
    expect(summary.clone_available).toBe(false);
  });

  it('clone root that is a file (not a directory) → empty + clone_available:false (AC-5)', async () => {
    const filePath = path.join(root, 'a-file');
    await writeFile(filePath, 'not a dir', 'utf8');
    const { summary } = await discover(filePath, tokenizer);
    expect(summary.clone_available).toBe(false);
  });
});
